"""Expiry settles only the fixed activated run's already acquired evidence."""

from decimal import Decimal

import pytest
from alerts import live_pricing, price_alert_close, price_alert_evaluator
from alerts.chart_alert_domain import Observation
from alerts.chart_alert_service import consume, create, current_version, lifecycle
from alerts.chart_alert_worker import evaluate, step
from alerts.market_contracts import DatasetIdentity
from alerts.storage import Audit, ChartAlert, Outbox, SignalRow
from sqlalchemy import func, select
from test_composite_alerts import append, armed, config
from test_live_pricing import quote


def publish(database, ident, at, price, seq):
    with database.begin() as db:
        identity = DatasetIdentity.model_validate(current_version(db, db.get(ChartAlert, ident)).market_identity["target_identity"])
    ownership = (live_pricing.account_key(live_pricing.settings.oanda_account_id), "test-owner")
    live_pricing.publish_event(ownership, 1, quote(identity, 1, seq=seq, source=at, received_at=at, bid=price),
        {"EUR_USD": identity}, now=at)


@pytest.mark.parametrize("mode", ["intrabar", "close"])
def test_expiry_saves_valid_delayed_signal_without_restarting_demand(database, monkeypatch, mode):
    expiry = 165600000 + 720000
    ident, _, revision, seam, stamp = armed(database, monkeypatch, mode=mode,
        expires_at=expiry, notify_ntfy=True, late_delivery="notify")
    if mode == "close":
        append(database, revision, seam + 600000, "1.119", seam + 660010)
    else:
        publish(database, ident, stamp + 100, "1.119", 1)
    with database.begin() as db:
        events = evaluate(db, ident, now=expiry + 300000)
        assert len(events) == 1
        assert events[0].created_at == expiry + 300000 and events[0].occurred_at < expiry
        assert events[0].evidence["late"] is True
        assert db.scalar(select(Outbox)).status == "pending"
        alert = db.get(ChartAlert, ident)
        assert alert.status == "expired" and alert.runtime["settlement_pending"] is False
        assert evaluate(db, ident, now=expiry + 300010) == []
    # Enabled composites keep their stream independently of expired alerts.
    assert set(live_pricing.desired_datasets(live_pricing.settings.oanda_account_id)) == {"EUR_USD"}


@pytest.mark.parametrize("mode", ["intrabar", "close"])
def test_event_at_exact_expiry_never_triggers(database, monkeypatch, mode):
    expiry = 165600000 + 660000
    ident, composite, revision, seam, stamp = armed(database, monkeypatch, mode=mode, expires_at=expiry)
    if mode == "close":
        append(database, revision, seam + 600000, "1.119", seam + 660010)
    else:
        # Another active consumer keeps the shared stream collecting at expiry.
        with database.begin() as db:
            create(db, "other-stream-consumer", config(composite, mode="intrabar"), at=stamp)
        publish(database, ident, expiry, "1.119", 1)
    with database.begin() as db:
        assert evaluate(db, ident, now=expiry + 10) == []
        assert db.get(ChartAlert, ident).runtime["settlement_pending"] is False
        assert db.scalar(select(SignalRow).where(SignalRow.chart_alert_id == ident)) is None


def test_expired_close_finishes_unresolved_window_and_never_waits_for_future_repair(database, monkeypatch):
    expiry = 165600000 + 780000
    ident, _, revision, seam, _ = armed(database, monkeypatch, expires_at=expiry)
    append(database, revision, seam + 660000, "1.119", seam + 720010)
    with database.begin() as db:
        assert evaluate(db, ident, now=expiry + 10) == []
        alert = db.get(ChartAlert, ident)
        assert alert.status == "expired" and not alert.runtime["settlement_pending"]
        assert alert.runtime["settlement"]["outcome"] == "confirmation_window_pending"
        assert db.scalar(select(Audit).where(Audit.kind == "chart_alert_unobserved"))
    append(database, revision, seam + 600000, "1.110", expiry + 20)
    with database.begin() as db:
        assert evaluate(db, ident, now=expiry + 30) == []
        assert db.scalar(select(SignalRow)) is None


def test_worker_resumes_expired_fixed_close_version_in_finite_batches(database, monkeypatch):
    monkeypatch.setattr(price_alert_close, "BATCH_SIZE", 1)
    expiry = 165600000 + 780001
    ident, _, revision, seam, _ = armed(database, monkeypatch, expires_at=expiry)
    for offset, price in [(600000, "1.110"), (660000, "1.119"), (720000, "1.110")]:
        append(database, revision, seam + offset, price, seam + offset + 60010)
    with database.begin() as db:
        assert evaluate(db, ident, now=expiry + 10) == []
        alert = db.get(ChartAlert, ident)
        assert alert.status == "expired" and alert.runtime["settlement_pending"]
        frozen = alert.runtime["settlement"]["input_revision"]
    # A correction after the frozen settlement cannot rewrite its selected version.
    append(database, revision, seam + 660000, "1.110", expiry + 20)
    assert step(now=expiry + 30) == 1
    with database.begin() as db:
        signal = db.scalar(select(SignalRow))
        assert signal and signal.evidence["price"] == "1.119"
        assert signal.evidence["observation"]["input_manifest"]["input_revision"] == frozen
        assert db.get(ChartAlert, ident).runtime["settlement_pending"]
    assert step(now=expiry + 40) == 1
    with database.begin() as db:
        assert not db.get(ChartAlert, ident).runtime["settlement_pending"]
        assert db.scalar(select(func.count()).select_from(SignalRow)) == 1
    assert step(now=expiry + 50) == 0


@pytest.mark.parametrize("action", ["pause", "archive"])
def test_user_lifecycle_cancels_pending_settlement(database, monkeypatch, action):
    monkeypatch.setattr(price_alert_close, "BATCH_SIZE", 1)
    expiry = 165600000 + 720001
    ident, _, revision, seam, _ = armed(database, monkeypatch, expires_at=expiry)
    append(database, revision, seam + 600000, "1.110", seam + 660010)
    append(database, revision, seam + 660000, "1.119", seam + 720010)
    with database.begin() as db:
        evaluate(db, ident, now=expiry + 10)
        alert = db.get(ChartAlert, ident)
        assert alert.runtime["settlement_pending"]
        lifecycle(db, ident, alert.version, action, expected_revision=alert.control_revision,
            request_id="stop-settlement", at=expiry + 20)
        assert not alert.runtime["settlement_pending"]
    assert step(now=expiry + 30) == 0
    with database.begin() as db:
        assert db.scalar(select(SignalRow)) is None


def test_consume_rejects_forged_or_old_run_settlement(database, monkeypatch):
    expiry = 165600000 + 720001
    ident, _, _, seam, _ = armed(database, monkeypatch, expires_at=expiry)
    with database.begin() as db:
        alert = db.get(ChartAlert, ident)
        alert.status = "expired"
        alert.runtime = {**alert.runtime, "settlement_pending": True, "settlement": {
            "version": alert.version, "run": alert.run + 1, "effective_at": alert.effective_at,
            "expires_at": expiry, "mode": "close", "cursor_limit": expiry, "input_revision": 1}}
        observation = Observation("forged", seam + 660000, seam + 660000, Decimal("1.119"), Decimal("1.115"))
        assert consume(db, ident, observation, detected_at=expiry + 10, settlement=True) is None
        assert consume(db, ident, observation, detected_at=expiry + 10) is None
        assert alert.count == 0


def test_intrabar_expiry_can_resume_multiple_batches(database, monkeypatch):
    reader = price_alert_evaluator.read_after
    monkeypatch.setattr(price_alert_evaluator, "read_after", lambda db, target, cursor: reader(db, target, cursor, limit=1))
    expiry = 165600000 + 601000
    ident, _, _, _, stamp = armed(database, monkeypatch, mode="intrabar", expires_at=expiry)
    for seq, price in enumerate(("1.110", "1.119", "1.110"), 1):
        publish(database, ident, stamp + seq * 100, price, seq)
    with database.begin() as db:
        assert evaluate(db, ident, now=expiry + 10) == []
        assert db.get(ChartAlert, ident).runtime["settlement_pending"]
    assert step(now=expiry + 20) == 1
    assert step(now=expiry + 30) == 1
    with database.begin() as db:
        alert = db.get(ChartAlert, ident)
        assert alert.count == 1 and not alert.runtime["settlement_pending"]
        assert alert.runtime["cursor"] == 3


def test_active_rule_rejects_event_time_at_expiry_even_before_worker_clock_reaches_it(database, monkeypatch):
    expiry = 165600000 + 601000
    ident, _, _, _, stamp = armed(database, monkeypatch, mode="intrabar", expires_at=expiry)
    with database.begin() as db:
        observation = Observation("future-source-time", 1, expiry, Decimal("1.119"), Decimal("1.115"))
        assert consume(db, ident, observation, detected_at=stamp + 100) is None
        assert db.get(ChartAlert, ident).status == "active"
        assert db.get(ChartAlert, ident).count == 0


def test_settlement_respects_remaining_trigger_count(database, monkeypatch):
    expiry = 165600000 + 601000
    ident, _, _, _, stamp = armed(database, monkeypatch, mode="intrabar", expires_at=expiry, max_triggers=1)
    for seq, price in enumerate(("1.119", "1.110", "1.119"), 1):
        publish(database, ident, stamp + seq * 100, price, seq)
    with database.begin() as db:
        assert len(evaluate(db, ident, now=expiry + 10)) == 1
        alert = db.get(ChartAlert, ident)
        assert alert.status == "completed" and alert.count == 1
        assert alert.runtime["cursor"] == 1
        assert alert.runtime["settlement_pending"] is False


def test_failure_before_settlement_commit_retries_same_inputs(database, monkeypatch):
    expiry = 165600000 + 601000
    ident, _, _, _, stamp = armed(database, monkeypatch, mode="intrabar", expires_at=expiry, notify_ntfy=True)
    publish(database, ident, stamp + 100, "1.119", 1)
    with pytest.raises(RuntimeError, match="rollback"):
        with database.begin() as db:
            assert len(evaluate(db, ident, now=expiry + 10)) == 1
            raise RuntimeError("rollback settlement, event and outbox")
    with database.begin() as db:
        assert db.get(ChartAlert, ident).status == "active"
        assert db.get(ChartAlert, ident).count == 0
        assert db.scalar(select(SignalRow)) is None
        assert db.scalar(select(Outbox)) is None
        assert len(evaluate(db, ident, now=expiry + 20)) == 1
    with database.begin() as db:
        assert evaluate(db, ident, now=expiry + 30) == []
        assert db.get(ChartAlert, ident).count == 1
        assert db.scalar(select(func.count()).select_from(Outbox)) == 1


def test_expiry_without_collected_tail_records_possible_unobserved_interval(database, monkeypatch):
    expiry = 165600000 + 720000
    ident, _, _, _, stamp = armed(database, monkeypatch, mode="intrabar", expires_at=expiry)
    with database.begin() as db:
        assert evaluate(db, ident, now=expiry + 10) == []
        alert = db.get(ChartAlert, ident)
        assert not alert.runtime["settlement_pending"]
        assert alert.runtime["settlement"]["outcome"] == "settlement_unobserved_input"
        gap = db.scalar(select(Audit).where(Audit.kind == "chart_alert_unobserved",
            Audit.details["reason_code"].as_string() == "expiry_unobserved_tail"))
        assert gap.details["start"] == stamp and gap.details["end"] == expiry


def test_expiry_during_dataset_lock_wait_still_settles_real_detected_time(database, monkeypatch):
    expiry = 165600000 + 601000
    ident, _, _, _, stamp = armed(database, monkeypatch, mode="intrabar", expires_at=expiry)
    publish(database, ident, stamp + 100, "1.119", 1)
    with database.begin() as db:
        events = evaluate(db, ident, now=expiry - 1, clock=lambda: expiry + 100)
        assert len(events) == 1
        assert events[0].created_at == expiry + 100
        assert db.get(ChartAlert, ident).status == "expired"


@pytest.mark.parametrize("mode", ["intrabar", "close"])
def test_disabled_acquisition_still_settles_committed_valid_input(database, monkeypatch, mode):
    from alerts.realtime_switch import set_enabled
    from alerts.storage import CompositeRevision, HistoryVersion, MarketDataset

    expiry = 165600000 + 720000
    ident, _, revision, seam, stamp = armed(database, monkeypatch, mode=mode, expires_at=expiry)
    if mode == "intrabar":
        publish(database, ident, stamp + 100, "1.119", 1)
    else:
        append(database, revision, seam + 600000, "1.119", seam + 660010)
    with database.begin() as db:
        source = db.get(HistoryVersion, db.get(CompositeRevision, revision).history_version_id).dataset_id
        set_enabled(db, db.get(MarketDataset, source).instrument_id, False, now=expiry - 1)
    with database.begin() as db:
        events = evaluate(db, ident, now=expiry + 10)
        assert len(events) == 1
        alert = db.get(ChartAlert, ident)
        assert alert.count == 1 and not alert.runtime["settlement_pending"]
        assert evaluate(db, ident, now=expiry + 20) == []
    assert not live_pricing.desired_datasets(live_pricing.settings.oanda_account_id)
