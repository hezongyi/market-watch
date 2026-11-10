"""Price close behavior through creation, source ingestion and worker commits."""

import copy

import pytest
from alerts.chart_alert_service import current_version
from alerts.chart_alert_worker import evaluate
from alerts.market_contracts import DatasetIdentity, RequestResult
from alerts.price_alert_confirmation import record
from alerts.storage import (
    Audit,
    ChartAlert,
    CompositeAggregateTask,
    CompositeJudgment,
    CompositePreparation,
    LiveMinute,
    SignalRow,
)
from sqlalchemy import select
from test_composite_aggregates import drain as aggregate
from test_composite_alerts import append, armed, live
from test_fixed_indicators import add_tail
from test_market_contracts import batch
from test_market_contracts import minute as source_minute


def minute(at, **changes):
    return source_minute(at, volume="3", **changes)


def query(database, ident, start, end, observed, *, status="empty_success", checkpoint=True):
    with database.begin() as db:
        identity = current_version(db, db.get(ChartAlert, ident)).market_identity["target_identity"]
        record(db, batch(identity=DatasetIdentity.model_validate(identity), window_start=start,
            window_end=end, checkpoint=end if checkpoint else None, observed_at=observed,
            result=RequestResult(status=status), rows=(), volume_kind="price_count", volume_unit="quotes"))


def test_close_backlog_ignores_current_quote_outage(database, monkeypatch):
    ident, _, revision, seam, stamp = armed(database, monkeypatch)
    append(database, revision, seam + 600000, "1.119", seam + 660010)
    live(database, revision, seam + 660010, seam + 660000, connected=False)
    with database.begin() as db:
        events = evaluate(db, ident, now=stamp + 300000)
        assert len(events) == 1
        assert events[0].occurred_at == seam + 660000
        assert events[0].evidence["late"] is True
        assert db.get(ChartAlert, ident).status == "active"


def test_sparse_m5_uses_bounded_query_without_faking_coverage(database, monkeypatch):
    ident, _, revision, seam, _ = armed(database, monkeypatch, timeframe="M5")
    add_tail(database, revision, [minute(seam + 600000, close="1.110"),
        minute(seam + 840000, close="1.119")], observed_at=seam + 900000)
    aggregate(revision, "M5")
    with database.begin() as db:
        events = evaluate(db, ident, now=seam + 900010)
        assert len(events) == 1
        bar = events[0].evidence["observation"]["bar"]
        assert bar["source_confirmed"] is True
        assert bar["coverage_complete"] is False
        assert bar["observed_minutes"] == 2


def test_first_unresolved_period_blocks_later_confirmed_cross(database, monkeypatch):
    ident, _, revision, seam, _ = armed(database, monkeypatch)
    append(database, revision, seam + 660000, "1.119", seam + 720010)
    with database.begin() as db:
        assert evaluate(db, ident, now=seam + 720010) == []
        alert = db.get(ChartAlert, ident)
        assert alert.runtime["close_cursor"] == seam + 600000
        assert alert.runtime["reason_code"] == "confirmation_window_pending"
    # A legacy unbounded empty reply is not a successful window proof.
    query(database, ident, seam + 600000, seam + 660000, seam + 720020, checkpoint=False)
    with database.begin() as db:
        assert evaluate(db, ident, now=seam + 720030) == []
    query(database, ident, seam + 600000, seam + 660000, seam + 720040)
    with database.begin() as db:
        assert len(evaluate(db, ident, now=seam + 720050)) == 1
        empty = db.scalar(select(Audit).where(Audit.kind == "chart_alert_no_observation"))
        assert empty.details["start"] == seam + 600000
        assert empty.details["end"] == seam + 660000


def test_failed_query_blocks_until_newer_success_covers_the_window(database, monkeypatch):
    ident, _, revision, seam, _ = armed(database, monkeypatch)
    append(database, revision, seam + 600000, "1.119", seam + 660010)
    query(database, ident, seam + 600000, seam + 660000, seam + 660020,
        status="timeout", checkpoint=False)
    with database.begin() as db:
        assert evaluate(db, ident, now=seam + 660030) == []
        assert db.get(ChartAlert, ident).runtime["reason_code"] == "confirmation_query_failed"
    # A delayed old successful response cannot erase a newer failure.
    query(database, ident, seam + 600000, seam + 660000, seam + 660015)
    with database.begin() as db:
        assert evaluate(db, ident, now=seam + 660040) == []
    query(database, ident, seam + 600000, seam + 660000, seam + 660050)
    with database.begin() as db:
        assert len(evaluate(db, ident, now=seam + 660060)) == 1


def test_observed_unconfirmed_member_blocks_sparse_close(database, monkeypatch):
    ident, _, revision, seam, _ = armed(database, monkeypatch, timeframe="M5")
    add_tail(database, revision, [minute(seam + 600000, close="1.110"),
        minute(seam + 840000, close="1.119")], observed_at=seam + 900000)
    aggregate(revision, "M5")
    with database.begin() as db:
        target = current_version(db, db.get(ChartAlert, ident)).market_identity["target_dataset_id"]
        db.add(LiveMinute(dataset_id=target, start=seam + 660000, expected=True,
            expectation="source_tradeable", first_attempt=seam + 660000, last_attempt=seam + 900000))
    with database.begin() as db:
        assert evaluate(db, ident, now=seam + 900010) == []
        assert db.get(ChartAlert, ident).runtime["reason_code"] == "observed_minute_unconfirmed"


def test_global_aggregation_lag_does_not_block_confirmed_older_range(database, monkeypatch):
    ident, _, revision, seam, _ = armed(database, monkeypatch)
    append(database, revision, seam + 600000, "1.119", seam + 660010)
    add_tail(database, revision, [minute(seam + 1200000)], observed_at=seam + 1260000)
    with database.begin() as db:
        assert db.get(CompositePreparation, revision).input_revision > db.get(
            CompositeAggregateTask, (revision, "M1")).applied_input_revision
        assert len(evaluate(db, ident, now=seam + 660020)) == 1


def test_correction_in_required_range_waits_for_aggregation(database, monkeypatch):
    ident, _, revision, seam, _ = armed(database, monkeypatch)
    append(database, revision, seam + 600000, "1.119", seam + 660010)
    add_tail(database, revision, [minute(seam + 600000, close="1.110")], observed_at=seam + 660020)
    with database.begin() as db:
        assert evaluate(db, ident, now=seam + 660030) == []
        assert db.get(ChartAlert, ident).runtime["reason_code"] == "confirmation_aggregation_pending"
    aggregate(revision, "M1")
    with database.begin() as db:
        assert evaluate(db, ident, now=seam + 660040) == []
        assert db.get(ChartAlert, ident).runtime["close_cursor"] == seam + 660000


@pytest.mark.parametrize("latest", [False, True])
def test_corrections_preserve_events_and_only_rebase_affected_latest_close(database, monkeypatch, latest):
    ident, _, revision, seam, _ = armed(database, monkeypatch)
    append(database, revision, seam + 600000, "1.119", seam + 660010)
    with database.begin() as db:
        evaluate(db, ident, now=seam + 660010)
        evidence = copy.deepcopy(db.scalar(select(SignalRow)).evidence)
        judgments = [copy.deepcopy(row.evidence) for row in db.scalars(select(CompositeJudgment))]
    add_tail(database, revision, [minute(seam + (600000 if latest else 60000), close="1.110" if latest else "1.118")],
        observed_at=seam + 660020)
    aggregate(revision, "M1")
    with database.begin() as db:
        assert evaluate(db, ident, now=seam + 660030) == []
        assert db.scalar(select(SignalRow)).evidence == evidence
        assert [row.evidence for row in db.scalars(select(CompositeJudgment))] == judgments
        alert = db.get(ChartAlert, ident)
        assert alert.count == 1
        assert alert.state["left"] == ("1.11" if latest else "1.119")
        assert db.scalar(select(Audit).where(Audit.kind == "chart_alert_input_revision"))


def test_batch_limit_resumes_at_exact_next_period(database, monkeypatch):
    ident, _, revision, seam, _ = armed(database, monkeypatch)
    start = seam + 600000
    add_tail(database, revision, [minute(start + i * 60000, close="1.119" if i == 128 else "1.11")
        for i in range(130)], observed_at=start + 130 * 60000)
    aggregate(revision, "M1")
    with database.begin() as db:
        assert evaluate(db, ident, now=start + 130 * 60000 + 10) == []
        assert db.get(ChartAlert, ident).runtime["close_cursor"] == start + 128 * 60000
    with database.begin() as db:
        events = evaluate(db, ident, now=start + 130 * 60000 + 20)
        assert len(events) == 1
        assert events[0].occurred_at == start + 129 * 60000
        assert db.get(ChartAlert, ident).runtime["close_cursor"] == start + 130 * 60000


def test_pending_latest_baseline_correction_blocks_future_comparison(database, monkeypatch):
    ident, _, revision, seam, _ = armed(database, monkeypatch)
    append(database, revision, seam + 600000, "1.119", seam + 660010)
    # Change the already captured baseline before the next event is consumed.
    add_tail(database, revision, [minute(seam + 540000, close="1.118")], observed_at=seam + 660020)
    with database.begin() as db:
        assert evaluate(db, ident, now=seam + 660030) == []
        assert db.get(ChartAlert, ident).runtime["reason_code"] == "confirmation_aggregation_pending"
    aggregate(revision, "M1")
    with database.begin() as db:
        assert evaluate(db, ident, now=seam + 660040) == []
        assert db.get(ChartAlert, ident).state["left"] == "1.119"
        assert db.scalar(select(SignalRow)) is None


def test_creation_with_old_seam_uses_verified_current_materialization(database, monkeypatch):
    from alerts.chart_alert_service import create
    from test_composite_alerts import config

    _, composite, revision, seam, _ = armed(database, monkeypatch)
    start = seam + 40 * 86400000
    monkeypatch.setattr("alerts.live_window.now_ms", lambda: start + 120010)
    monkeypatch.setattr("alerts.composite_series.now_ms", lambda: start + 120010)
    add_tail(database, revision, [minute(start, close="1.11")], observed_at=start + 60000)
    aggregate(revision, "M1")
    with database.begin() as db:
        ident = create(db, "current-materialization", config(composite), at=start + 60010).id
        assert db.get(ChartAlert, ident).state["left"] == "1.11"
    append(database, revision, start + 60000, "1.119", start + 120010)
    with database.begin() as db:
        assert len(evaluate(db, ident, now=start + 120010)) == 1


def test_create_without_confirmed_baseline_first_future_close_is_only_baseline(database, monkeypatch):
    from alerts.chart_alert_service import create
    from test_composite_alerts import config

    _, composite, revision, seam, _ = armed(database, monkeypatch)
    # Creation is allowed while the aggregate worker has not published a version.
    with database.begin() as db:
        task = db.get(CompositeAggregateTask, (revision, "M1"))
        task.applied_input_revision = -1
        ident = create(db, "no-baseline", config(composite), at=seam + 600010).id
        assert db.get(ChartAlert, ident).state == {}
        task.applied_input_revision = 1
    append(database, revision, seam + 600000, "1.119", seam + 660010)
    with database.begin() as db:
        assert evaluate(db, ident, now=seam + 660010) == []
        assert db.get(ChartAlert, ident).state["left"] == "1.119"
        assert db.get(ChartAlert, ident).runtime["needs_baseline"] is False


@pytest.mark.parametrize("frame", ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN"])
def test_all_existing_periods_use_source_confirmed_sparse_close(database, monkeypatch, frame):
    from alerts.chart_alert_service import create
    from alerts.composite_inputs import apply_minutes
    from alerts.composite_series import period
    from alerts.confirmed_minutes import record as record_minutes
    from alerts.storage import CompositeRevision, MarketDataset, RealtimeMapping
    from test_composite_alerts import config

    _, composite, revision_id, seam, _ = armed(database, monkeypatch)
    with database.begin() as db:
        revision = db.get(CompositeRevision, revision_id)
        phase = revision.rules["aggregation_calendar"]
        target = db.get(MarketDataset, db.get(RealtimeMapping, revision.mapping_id).target_dataset_id)
        identity = DatasetIdentity.model_validate(target.identity)
    # First pure-target period after the seam (February for MN, 28 days).
    start = period(seam + 600000, frame, phase)[1]
    end = period(start, frame, phase)[1]
    monkeypatch.setattr("alerts.live_window.now_ms", lambda: end + 10)
    monkeypatch.setattr("alerts.composite_series.now_ms", lambda: end + 10)
    with database.begin() as db:
        ident = create(db, "period-" + frame, config(composite, timeframe=frame), at=start + 10).id
        had_baseline = bool(db.get(ChartAlert, ident).state)
        apply_minutes(db, record_minutes(db, batch(identity=identity, window_start=start,
            window_end=end, checkpoint=end, observed_at=end, rows=(minute(end - 60000, close="1.119"),),
            volume_kind="price_count", volume_unit="quotes")))
    aggregate(revision_id, frame)
    with database.begin() as db:
        events = evaluate(db, ident, now=end + 10)
        assert len(events) == int(had_baseline)
        alert = db.get(ChartAlert, ident)
        assert alert.runtime["close_cursor"] == end
        assert alert.state["left"] == "1.119"
        bar = db.scalars(select(CompositeJudgment).where(CompositeJudgment.alert_version_id ==
            current_version(db, alert).id).order_by(CompositeJudgment.event_time.desc())).first().evidence["bar"]
        assert bar["end"] == end
        assert bar["coverage_complete"] is (frame == "M1")


def test_monthly_materialization_with_truncated_start_is_explicitly_blocked(database, monkeypatch):
    from alerts.chart_alert_service import create
    from alerts.composite_series import period
    from alerts.storage import CompositeRevision
    from test_composite_alerts import config

    _, composite, revision, seam, _ = armed(database, monkeypatch)
    with database.begin() as db:
        phase = db.get(CompositeRevision, revision).rules["aggregation_calendar"]
    # March 1970 has 31 days; the existing live reader cannot recover its first day at April 1.
    february = period(seam, "MN", phase)[1]
    start = period(february, "MN", phase)[1]
    end = period(start, "MN", phase)[1]
    with database.begin() as db:
        ident = create(db, "monthly-truncated", config(composite, timeframe="MN"), at=start + 10).id
    query(database, ident, start, start + 86400000, start + 86400000)
    monkeypatch.setattr("alerts.live_window.now_ms", lambda: end + 10)
    monkeypatch.setattr("alerts.composite_series.now_ms", lambda: end + 10)
    add_tail(database, revision, [minute(end - 60000, close="1.119")], observed_at=end)
    query(database, ident, start + 86400000, end, end)
    aggregate(revision, "MN")
    with database.begin() as db:
        assert evaluate(db, ident, now=end + 10) == []
        alert = db.get(ChartAlert, ident)
        assert alert.runtime["close_cursor"] == start
        assert alert.runtime["reason_code"] == "confirmation_window_unreadable"
        assert alert.status == "active" and alert.health == "blocked"


def test_expired_failure_evidence_cannot_silently_certify_old_bar(database, monkeypatch):
    from alerts.price_alert_confirmation import facts

    ident, _, revision, seam, _ = armed(database, monkeypatch)
    append(database, revision, seam + 600000, "1.119", seam + 660010)
    query(database, ident, seam + 600000, seam + 660000, seam + 660020,
        status="timeout", checkpoint=False)
    later = seam + 40 * 86400000
    query(database, ident, later, later + 60000, later + 60000)
    with database.begin() as db:
        alert = db.get(ChartAlert, ident)
        fact = facts(db, current_version(db, alert).market_identity["target_identity"])
        assert fact["failures"] == [] and fact["unreadable_failure"] == [seam + 600000, seam + 660000]
        assert evaluate(db, ident, now=later + 60000) == []
        assert alert.runtime["reason_code"] == "confirmation_window_unreadable"


@pytest.mark.parametrize("week", ["2026-03-06T21:59:00+00:00", "2026-10-30T20:59:00+00:00"])
@pytest.mark.parametrize("frame", ["M1", "W1"])
def test_final_session_close_is_consumed_during_weekend_across_dst(database, monkeypatch, week, frame):
    from datetime import datetime, timedelta

    from alerts.chart_alert_service import create
    from alerts.composite_series import period
    from alerts.config import settings
    from alerts.storage import MarketDataset
    from test_composite_alerts import config
    from test_live_session import generator

    original, composite, revision, _, _ = armed(database, monkeypatch)
    last_minute = int(datetime.fromisoformat(week).timestamp() * 1000)
    start, end = period(last_minute, frame, "ny17")
    observed = end + 60001
    for module in ("live_window", "composite_series"):
        monkeypatch.setattr("alerts." + module + ".now_ms", lambda: observed)
    with database.begin() as db:
        target_id = current_version(db, db.scalar(select(ChartAlert))).market_identity["target_dataset_id"]
        target = db.get(MarketDataset, target_id)
        profile = generator()(target.identity["account_scope"],
            datetime.fromisoformat(week) - timedelta(days=1),
            datetime.fromisoformat(week) + timedelta(days=4),
            ["EUR_USD"])["EUR_USD"]
    monkeypatch.setattr(settings, "oanda_live_session_profiles", {"EUR_USD": profile})
    # The previous bucket supplies an actual baseline; sparse completed queries
    # cover intervening open minutes without pretending that each has a candle.
    add_tail(database, revision, [minute(start - 60000, close="1.110")], observed_at=start)
    query(database, original, period(start - 60000, frame, "ny17")[0], start, start)
    aggregate(revision, frame)
    with database.begin() as db:
        ident = create(db, "final-session-" + frame, config(composite, timeframe=frame), at=start + 10).id
        assert db.get(ChartAlert, ident).state["left"] == "1.11"
    add_tail(database, revision, [minute(last_minute, close="1.119")], observed_at=observed)
    query(database, ident, start, end, observed)
    aggregate(revision, frame)
    live(database, revision, observed, last_minute + 60000, connected=False)
    with database.begin() as db:
        events = evaluate(db, ident, now=observed)
        assert len(events) == 1
        assert events[0].occurred_at == end
        alert = db.get(ChartAlert, ident)
        assert alert.runtime["execution_state"] == "closed"
        assert alert.runtime["close_cursor"] >= end
        assert evaluate(db, ident, now=observed + 1) == []
