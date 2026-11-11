"""Transactional observation retention through the real collector interfaces."""

import pytest
from alerts import live_pricing
from alerts.chart_alert_service import current_version
from alerts.market_contracts import DatasetIdentity, RequestResult
from alerts.price_alert_inputs import is_price_rule, prune, read_after
from alerts.storage import ChartAlert, LiveState, PriceAlertInput, PriceAlertStream
from sqlalchemy import func, select
from test_composite_alerts import armed
from test_live_pricing import quote


@pytest.fixture
def collecting(database, monkeypatch):
    ident, _, _, _, stamp = armed(database, monkeypatch, mode="intrabar")
    with database.begin() as db:
        alert = db.get(ChartAlert, ident)
        identity = DatasetIdentity.model_validate(current_version(db, alert).market_identity["target_identity"])
        state = db.get(LiveState, identity.key)
        state.quote = {**state.quote, "sequence": 0, "received_at": stamp}
    ownership = (live_pricing.account_key(live_pricing.settings.oanda_account_id), "test-owner")
    return database, ident, identity, ownership, stamp


def publish(fixture, seq, price, *, at=None):
    _, _, identity, owner, stamp = fixture
    at = stamp + seq * 100 if at is None else at
    return live_pricing.publish_event(owner, 1,
        quote(identity, 1, seq=seq, source=at, received_at=at, bid=price),
        {"EUR_USD": identity}, now=at)


def test_same_millisecond_prices_have_distinct_sequences_and_replay_is_noop(collecting):
    factory, _, identity, _, stamp = collecting
    for seq, price in enumerate(("1.110", "1.120", "1.110"), 1):
        assert publish(collecting, seq, price, at=stamp + 100) == "accepted"
    assert publish(collecting, 3, "1.110", at=stamp + 100) == "rejected_sequence"
    with factory.begin() as db:
        rows = read_after(db, identity.key, 0)
        assert [r.price for r in rows] == ["1.110", "1.120", "1.110"]
        assert [r.sequence for r in rows] == [1, 2, 3]
        assert {r.occurred_at for r in rows} == {stamp + 100}
        assert db.get(LiveState, identity.key).quote["bid"] == "1.110"


def test_log_failure_rolls_back_latest_snapshot_and_sequence(collecting, monkeypatch):
    from alerts import price_alert_inputs

    factory, _, identity, _, _ = collecting
    publish(collecting, 1, "1.110")
    original = price_alert_inputs.record_quote

    def fail(*args, **kwargs):
        original(*args, **kwargs)
        raise RuntimeError("injected after append before commit")

    with monkeypatch.context() as patch:
        patch.setattr(price_alert_inputs, "record_quote", fail)
        with pytest.raises(RuntimeError, match="injected"):
            publish(collecting, 2, "1.120")
    with factory.begin() as db:
        assert db.get(LiveState, identity.key).quote["bid"] == "1.110"
        assert db.get(PriceAlertStream, identity.key).sequence == 1
    publish(collecting, 2, "1.120")
    with factory.begin() as db:
        assert [r.price for r in read_after(db, identity.key, 0)] == ["1.110", "1.120"]


def test_no_new_log_without_enabled_touch_demand(collecting):
    factory, ident, _, _, _ = collecting
    with factory.begin() as db:
        db.get(ChartAlert, ident).status = "paused"
    publish(collecting, 1, "1.110")
    with factory.begin() as db:
        assert db.scalar(select(func.count()).select_from(PriceAlertInput)) == 0


def test_retention_loss_boundary_survives_deletion_and_transaction_rollback(collecting):
    factory, _, identity, _, stamp = collecting
    for seq in range(1, 5):
        publish(collecting, seq, "1.110")
    with pytest.raises(RuntimeError):
        with factory.begin() as db:
            assert prune(db, identity.key, now=stamp + 500, max_rows=2) == 2
            raise RuntimeError("rollback retention")
    with factory.begin() as db:
        assert db.get(PriceAlertStream, identity.key).trimmed_through == 0
        assert len(read_after(db, identity.key, 0)) == 4
        assert prune(db, identity.key, now=stamp + 500, max_rows=2) == 2
    with factory.begin() as db:
        stream = db.get(PriceAlertStream, identity.key)
        assert stream.trimmed_through == 2
        assert (stream.trimmed_start, stream.trimmed_end) == (stamp + 100, stamp + 200)
        assert [r.sequence for r in read_after(db, identity.key, 0)] == [3, 4]


def test_disconnect_persists_marker_in_the_same_transaction(collecting):
    factory, _, identity, owner, stamp = collecting
    publish(collecting, 1, "1.110")
    live_pricing.disconnected(owner, 1, {"EUR_USD": identity},
        RequestResult(status="timeout"), now=stamp + 200)
    with factory.begin() as db:
        rows = read_after(db, identity.key, 0)
        assert [r.kind for r in rows] == ["price", "interruption"]
        assert rows[-1].evidence["reason_code"] == "timeout"
        assert db.get(LiveState, identity.key).connection == "disconnected"


def test_rest_samples_keep_receive_time_contract_and_mode_boundary(collecting):
    from alerts.oanda_rest_batch import CandleSpec, live_demand_revision, normalize_latest

    factory, _, identity, owner, stamp = collecting
    publish(collecting, 1, "1.110")
    spec = CandleSpec.from_dataset(identity)
    payload = {"latestCandles": [{"instrument": "EUR_USD", "granularity": "M1", "candles": [
        {"time": str(stamp // 60000 * 60), "complete": False, "volume": 3,
         "bid": {"o": "1.11", "h": "1.13", "l": "1.10", "c": "1.12"}}]}]}
    batch = normalize_latest(payload, [spec], generation=1, sequence=2,
        demand_revision=live_demand_revision([spec]), requested_at=stamp + 200, received_at=stamp + 300)
    live_pricing.publish_rest_batch(owner, 1, batch, {"EUR_USD": identity}, now=stamp + 300)
    live_pricing.publish_rest_batch(owner, 1, batch, {"EUR_USD": identity}, now=stamp + 300)
    with factory.begin() as db:
        rows = read_after(db, identity.key, 0)
        assert [r.kind for r in rows] == ["price", "interruption", "price"]
        assert rows[1].evidence["reason_code"] == "observation_mode_changed"
        assert rows[-1].price == "1.12" and rows[-1].occurred_at == stamp + 300
        assert rows[-1].mode == "candle_close_sample"


@pytest.mark.parametrize("kind,expected", [("horizontal_line", True), ("horizontal_ray", False),
    ("trend_line", False), ("ray", False)])
def test_classifier_does_not_absorb_complex_rules(kind, expected):
    config = {"series_kind": "composite", "condition": {"left": {"kind": "price"},
        "right": {"kind": "line", "line": {"kind": kind}}, "relation": "cross"}}
    assert is_price_rule(config) is expected
    config["condition"]["offset"] = {"kind": "atr"}
    assert not is_price_rule(config)


def test_hard_dataset_limit_without_evaluator_and_recovery_boundary(collecting, monkeypatch):
    from alerts import price_alert_inputs
    from alerts.chart_alert_worker import evaluate

    monkeypatch.setattr(price_alert_inputs, "MAX_DATASET_INPUTS", 3)
    factory, ident, identity, _, stamp = collecting
    for seq, price in enumerate(("1.110", "1.120", "1.110", "1.120", "1.110"), 1):
        publish(collecting, seq, price)
        with factory.begin() as db:
            assert db.scalar(select(func.count()).select_from(PriceAlertInput)) <= 3
    with factory.begin() as db:
        assert evaluate(db, ident, now=stamp + 600)
        alert = db.get(ChartAlert, ident)
        # The evicted crossing is unknowable; the retained first price sets a
        # baseline, then the retained second crossing is still consumed.
        assert alert.count == 1
        assert alert.runtime["last_gap"]["reason_code"] == "input_retention_exceeded"
        assert db.get(PriceAlertStream, identity.key).trimmed_through == 2


def test_retention_reclaims_acknowledged_inputs_and_age_without_new_quotes(collecting):
    from alerts.chart_alert_worker import evaluate
    from alerts.price_alert_inputs import MAX_AGE_MS, maintain

    factory, ident, identity, _, stamp = collecting
    publish(collecting, 1, "1.110")
    with factory.begin() as db:
        evaluate(db, ident, now=stamp + 150)
        assert prune(db, identity.key, now=stamp + 150) == 1
    publish(collecting, 2, "1.120")
    maintain(now=stamp + 300 + MAX_AGE_MS)
    with factory.begin() as db:
        assert read_after(db, identity.key, 0) == []
        assert db.get(PriceAlertStream, identity.key).trimmed_through == 2


def test_global_limit_prefers_acknowledged_data_across_datasets(collecting, monkeypatch):
    from alerts import price_alert_inputs
    from alerts.chart_alert_worker import evaluate
    from alerts.market_datasets import register_dataset
    from alerts.storage import ChartAlertVersion

    factory, ident, identity, owner, stamp = collecting
    second = identity.model_copy(update={"provider_symbol": "GBP_USD"})
    # A second task-owned acquisition demand exercises the shared log budget.
    # Rule identity/evaluation for that source is covered by integration cases.
    with factory.begin() as db:
        register_dataset(db, second, logical_symbol="GBPUSD", label="Fixture GBP",
            calendar="ny17", precision=5, volume_kind="price_count", volume_unit="quotes")
        db.add(LiveState(dataset_id=second.key, epoch=1, connection="connected", ready=True))
        first = db.get(ChartAlert, ident)
        version = current_version(db, first)
        clone = ChartAlert(request_id="budget-fixture", request_hash="budget-fixture", name="Budget",
            effective_at=stamp, max_triggers=3, runtime={"execution_contract": "price-v2", "cursor": 0})
        db.add(clone)
        db.flush()
        db.add(ChartAlertVersion(alert_id=clone.id, version=1, effective_at=stamp,
            config=version.config, market_identity={**version.market_identity, "target_dataset_id": second.key}))
    monkeypatch.setattr(price_alert_inputs, "MAX_GLOBAL_INPUTS", 3)
    publish(collecting, 1, "1.110")
    publish(collecting, 2, "1.110")
    with factory.begin() as db:
        evaluate(db, ident, now=stamp + 250)
    for seq in range(1, 5):
        at = stamp + 300 + seq * 100
        live_pricing.publish_event(owner, 1, quote(second, 1, seq=seq, source=at,
            received_at=at, bid="1.110"), {"GBP_USD": second}, now=at)
        with factory.begin() as db:
            assert db.scalar(select(func.count()).select_from(PriceAlertInput)) <= 3
    with factory.begin() as db:
        assert read_after(db, identity.key, 0) == []
        assert db.get(PriceAlertStream, identity.key).trimmed_through == 2
        assert db.get(PriceAlertStream, second.key).trimmed_through == 1
        assert [r.sequence for r in read_after(db, second.key, 0)] == [2, 3, 4]


def test_rest_logging_does_not_depend_on_display_capacity(collecting, monkeypatch):
    from alerts import display_observations

    monkeypatch.setattr(display_observations, "MAX_MINUTES", 0)
    test_rest_samples_keep_receive_time_contract_and_mode_boundary(collecting)


def test_collector_gap_is_not_worker_delay_and_epoch_alone_is_not_continuity(collecting):
    from alerts.chart_alert_worker import evaluate

    factory, ident, identity, owner, stamp = collecting
    publish(collecting, 1, "1.110")
    publish(collecting, 2, "1.120", at=stamp + 16000)
    with factory.begin() as db:
        assert evaluate(db, ident, now=stamp + 17000) == []
        assert db.get(ChartAlert, ident).runtime["last_gap"]["reason_code"] == "price_sample_gap"
    epoch = live_pricing.begin_connection(owner, {"EUR_USD": identity}, now=stamp + 17500)
    live_pricing.publish_event(owner, epoch, quote(identity, epoch, seq=1, source=stamp + 18000,
        received_at=stamp + 18000, bid="1.110"), {"EUR_USD": identity}, now=stamp + 18000)
    with factory.begin() as db:
        assert evaluate(db, ident, now=stamp + 18100) == []
        alert = db.get(ChartAlert, ident)
        assert alert.runtime["last_gap"]["reason_code"] == "unverified_connection_boundary"
        assert alert.count == 0


@pytest.mark.parametrize("late_delivery", ["notify", "log_only"])
def test_continuous_backlog_preserves_cross_and_late_delivery(database, monkeypatch, late_delivery):
    from alerts.chart_alert_worker import evaluate
    from alerts.storage import Notification, Outbox, SignalRow
    from test_composite_alerts import price_sample

    ident, _, revision, _, stamp = armed(database, monkeypatch, mode="intrabar",
        notify_ntfy=True, late_delivery=late_delivery)
    for seq in range(1, 16):
        price_sample(database, revision, stamp + seq * 10000, "1.120" if seq == 13 else "1.110")
    with database.begin() as db:
        assert len(evaluate(db, ident, now=stamp + 400000)) == 1
        signal = db.scalar(select(SignalRow))
        assert signal.occurred_at == stamp + 130000
        assert signal.evidence["late"] is True
        assert signal.evidence["detected_at"] == stamp + 400000
        assert db.scalar(select(Notification)).status == ("pending" if late_delivery == "notify" else "late_suppressed")
        assert db.scalar(select(Outbox)).status == ("pending" if late_delivery == "notify" else "suppressed")
        assert db.get(ChartAlert, ident).count == 1


def test_verified_closure_preserves_baseline_across_connection_change(collecting, monkeypatch):
    from alerts.chart_alert_worker import evaluate
    from alerts.storage import Audit, instant

    factory, ident, identity, owner, stamp = collecting
    start, end = (stamp // 60000 + 1) * 60000, (stamp // 60000 + 2) * 60000
    profile = {"revision": "controlled-closure", "closures": [{
        "start": instant(start).isoformat(), "end": instant(end).isoformat(),
        "reason": "Fixture maintenance", "source": "https://example.test/fixture"}],
        "source_session": {**{key: identity.model_dump()[key] for key in
            ("source", "channel", "environment", "provider_symbol", "account_scope")},
            "timezone": "America/New_York", "reviewed_start": instant(start - 60000).isoformat(),
            "reviewed_end": instant(end + 60000).isoformat(), "weekly_closures": [],
            "evidence_url": "https://example.test/fixture", "applicability": "Isolated test only"}}
    monkeypatch.setattr(live_pricing.settings, "oanda_live_session_profiles", {"EUR_USD": profile})
    publish(collecting, 1, "1.110", at=start - 5000)
    with factory.begin() as db:
        evaluate(db, ident, now=start - 4000)
        prior_gaps = db.scalar(select(func.count()).select_from(Audit).where(Audit.kind == "chart_alert_unobserved"))
    live_pricing.park_closed(owner, {"EUR_USD": identity}, 60, now=start + 1)
    with factory.begin() as db:
        assert evaluate(db, ident, now=start + 1000) == []
        assert db.get(ChartAlert, ident).runtime["execution_state"] == "closed"
    successor = live_pricing.claim(live_pricing.settings.oanda_account_id, now=end + 5000)
    epoch = live_pricing.begin_connection(successor, {"EUR_USD": identity}, now=end + 5000)
    live_pricing.publish_event(successor, epoch, quote(identity, epoch, seq=1, source=end + 5000,
        received_at=end + 5000, bid="1.120"), {"EUR_USD": identity}, now=end + 5000)
    with factory.begin() as db:
        assert len(evaluate(db, ident, now=end + 5100)) == 1
        assert db.scalar(select(func.count()).select_from(Audit).where(Audit.kind == "chart_alert_unobserved")) == prior_gaps


def test_resume_after_idle_registration_does_not_lose_first_future_cross(collecting):
    from alerts.chart_alert_service import lifecycle
    from alerts.chart_alert_worker import evaluate

    factory, ident, _, _, stamp = collecting
    publish(collecting, 1, "1.110")
    with factory.begin() as db:
        row = db.get(ChartAlert, ident)
        lifecycle(db, ident, row.version, "pause", expected_revision=row.control_revision,
            request_id="pause-fixture", at=stamp + 200)
    publish(collecting, 2, "1.110", at=stamp + 20000)
    with factory.begin() as db:
        row = db.get(ChartAlert, ident)
        lifecycle(db, ident, row.version, "resume", expected_revision=row.control_revision,
            request_id="resume-fixture", at=stamp + 20100)
    publish(collecting, 3, "1.120", at=stamp + 20200)
    with factory.begin() as db:
        assert len(evaluate(db, ident, now=stamp + 20300)) == 1
        assert db.get(ChartAlert, ident).count == 1


def test_age_limit_is_applied_before_evaluation_even_without_periodic_cleanup(collecting, monkeypatch):
    from alerts import price_alert_inputs
    from alerts.chart_alert_worker import evaluate

    factory, ident, identity, _, stamp = collecting
    monkeypatch.setattr(price_alert_inputs, "MAX_AGE_MS", 1000)
    publish(collecting, 1, "1.120")
    with factory.begin() as db:
        assert evaluate(db, ident, now=stamp + 2000) == []
        row = db.get(ChartAlert, ident)
        assert row.runtime["last_gap"]["reason_code"] == "input_retention_exceeded"
        assert row.count == 0
        assert read_after(db, identity.key, 0) == []
