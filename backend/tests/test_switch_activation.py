"""Consistent activation, deduplicated failure reports and old-revision fencing."""

import pytest
import test_composite_revisions as contracts
from alerts import switch_activation, switch_runs, switch_source
from alerts.chart_alert_service import create as create_alert
from alerts.composite_aggregates import Fenced, aggregate_tick, claim, commit
from alerts.composite_inputs import apply_minutes, frozen
from alerts.composite_revisions import activate, create
from alerts.confirmed_minutes import record
from alerts.market_contracts import DatasetIdentity
from alerts.storage import (
    Audit,
    ChartAlert,
    ChartAlertVersion,
    CompositeActivation,
    CompositeAggregateBar,
    CompositeAggregateTask,
    CompositeJudgment,
    CompositePreparation,
    CompositeRevision,
    HistoryVersion,
    Instrument,
    MarketComposite,
    MarketDataset,
    MarketSwitchRun,
    Notification,
    Outbox,
    RealtimeMapping,
)
from sqlalchemy import delete, func, select
from test_composite_alerts import config
from test_market_contracts import batch, minute

STAMP = 200010000
BOUNDARY = STAMP // 60000 * 60000


def candidate(database, monkeypatch):
    """A prepared explicit re-baseline of the running composite."""
    composite, old, body = contracts.request(database, monkeypatch)
    with database.begin() as db:
        ident = create(db, composite, body).id
    contracts.prepared(database, ident)
    return composite, old, ident, body


def rules(database, monkeypatch, composite, old, ident):
    """One rule left on the running revision and one bound to the candidate."""
    # Eligibility is covered by the alert contract suite; these rules only need
    # their fixed binding identity.
    monkeypatch.setattr("alerts.composite_alerts.require_live_eligibility",
                        lambda *args, **kwargs: None)
    with database.begin() as db:
        return (create_alert(db, "switch-old-rule", config(composite), at=STAMP).id,
                create_alert(db, "switch-aligned-rule",
                             config(composite, composite_revision_id=ident), at=STAMP).id)


def late_batch(database, revision_id, start):
    with database.begin() as db:
        revision = db.get(CompositeRevision, revision_id)
        target = db.get(MarketDataset,
                        db.get(RealtimeMapping, revision.mapping_id).target_dataset_id)
        source = batch(identity=DatasetIdentity.model_validate(target.identity),
            window_start=start, window_end=start + 60000, checkpoint=start + 60000,
            observed_at=start + 60000, volume_kind="price_count", volume_unit="quotes",
            rows=(minute(start, volume="3"),))
        recorded = record(db, source)
        return recorded, apply_minutes(db, recorded)


def counts(database, model):
    with database() as db:
        return db.scalar(select(func.count()).select_from(model))


def test_activation_binds_one_state_and_freezes_the_previous(database, monkeypatch):
    composite, old, ident, _ = candidate(database, monkeypatch)
    old_rule, aligned = rules(database, monkeypatch, composite, old, ident)
    with database() as db:
        previous_identity = dict(db.scalar(select(ChartAlertVersion.market_identity).where(
            ChartAlertVersion.alert_id == old_rule, ChartAlertVersion.version == 1)))
        previous_config = dict(db.scalar(select(ChartAlertVersion.config).where(
            ChartAlertVersion.alert_id == old_rule, ChartAlertVersion.version == 1)))
    monkeypatch.setattr("alerts.composite_revisions.now_ms", lambda: STAMP)
    with database.begin() as db:
        activation = activate(db, composite, ident,
                              {"request_id": "consistent", "expected_revision_id": old})
        run = db.scalar(select(MarketSwitchRun))
        assert activation.event_boundary == BOUNDARY
        assert db.get(MarketComposite, composite).active_revision_id == ident
        assert db.get(CompositeRevision, ident).activated_at == STAMP
        # Charts follow the head revision; the alert binding table is explicit.
        evidence = activation.evidence["switch"]
        assert evidence["alerts"]["aligned"] == [
            {"id": aligned, "revision_id": ident, "version": 1}]
        assert evidence["alerts"]["rebound"] == [{"id": old_rule, "revision_id": ident,
            "version": 2, "previous_revision_id": old}]
        assert evidence["alerts"]["paused"] == []
        assert evidence["alerts"]["boundary"] == BOUNDARY
        assert evidence["fence"]["waterline"] == db.get(CompositePreparation, old).input_revision
        # Metric rebuild covers every frame at the activating input revision.
        value = db.get(CompositePreparation, ident).input_revision
        tasks = list(db.scalars(select(CompositeAggregateTask).where(
            CompositeAggregateTask.revision_id == ident)))
        assert len(tasks) == len(evidence["metrics"]["frames"])
        assert all(task.applied_input_revision >= value and task.error is None
                   and task.lease_until == 0 for task in tasks)
        # The candidate rule restarts its baseline at the boundary, unchanged identity.
        row = db.get(ChartAlert, aligned)
        assert (row.status, row.state, row.effective_at) == ("active", {}, BOUNDARY)
        assert row.control_revision == 2
        assert row.runtime["switch_run_id"] == run.id
        # The running rule is relocated by a new immutable version, not rewritten.
        moved = db.get(ChartAlert, old_rule)
        assert moved.version == 2
        assert db.scalar(select(ChartAlertVersion.market_identity).where(
            ChartAlertVersion.alert_id == old_rule,
            ChartAlertVersion.version == 1)) == previous_identity
        bound = dict(db.scalar(select(ChartAlertVersion.market_identity).where(
            ChartAlertVersion.alert_id == old_rule, ChartAlertVersion.version == 2)))
        assert bound["composite_revision_id"] == ident
        # Everything the revision cannot influence is byte-identical.
        stable = ("instrument", "instrument_id", "series_kind", "source", "symbol", "basis",
                  "timeframe", "precision", "composite_id", "history_version_id", "dataset_id",
                  "mapping_id", "target_dataset_id", "target_identity", "seam_policy",
                  "calculation_algorithm", "contract")
        assert {key: bound[key] for key in stable} == {
            key: previous_identity[key] for key in stable}
        assert (bound["seam"], bound["rules"], bound["initial_input_revision"]) == (
            db.get(CompositeRevision, ident).seam, db.get(CompositeRevision, ident).rules,
            db.get(CompositePreparation, ident).input_revision)
        config_row = dict(db.scalar(select(ChartAlertVersion.config).where(
            ChartAlertVersion.alert_id == old_rule, ChartAlertVersion.version == 2)))
        assert config_row.pop("composite_revision_id") == ident
        # Condition, geometry, limits and delivery choice are untouched.
        assert config_row == {key: value for key, value in previous_config.items()
                              if key != "composite_revision_id"}
        audit = db.scalar(select(Audit.details).where(Audit.kind == "chart_alert_rebound",
            Audit.details["alert_id"].as_string() == old_rule))
        assert (audit["previous_revision_id"], audit["revision_id"]) == (old, ident)
        assert audit["run_id"] == run.id and audit["boundary"] == BOUNDARY
        assert (moved.status, moved.state, moved.effective_at) == ("active", {}, BOUNDARY)
        assert moved.control_revision == 2 and moved.runtime["switch_run_id"] == run.id
        # The previous revision keeps its fixed waterline and accepts no new task.
        assert frozen(db.get(CompositePreparation, old))
        assert db.scalar(select(CompositeAggregateTask.lease_token).where(
            CompositeAggregateTask.revision_id == old)) is None
        # Only the durable succeeded row unlocks the cleanup.
        assert (run.state, run.phase, run.attempts) == ("succeeded", "activated", 0)
        assert run.activation["event_boundary"] == BOUNDARY
        unlocked = run.id
    # Only a committed succeeded row is visible to the cleanup pass.
    assert [item["id"] for item in switch_runs.unlocked_runs()] == [unlocked]
    assert counts(database, Notification) == 0  # a switch reports failures only


def test_partial_failure_rolls_back_and_never_unlocks(database, monkeypatch):
    composite, old, ident, _ = candidate(database, monkeypatch)
    old_rule, aligned = rules(database, monkeypatch, composite, old, ident)
    real = switch_activation.freeze_previous

    def freeze_fails(*args, **kwargs):
        raise ValueError("旧修订冻结失败")

    monkeypatch.setattr(switch_activation, "freeze_previous", freeze_fails)
    monkeypatch.setattr("alerts.composite_revisions.now_ms", lambda: STAMP)
    with pytest.raises(ValueError, match="冻结失败"):
        with database.begin() as db:
            activate(db, composite, ident,
                     {"request_id": "partial", "expected_revision_id": old})
    monkeypatch.setattr(switch_activation, "freeze_previous", real)
    with database() as db:
        assert db.get(MarketComposite, composite).active_revision_id == old
        assert db.get(CompositeActivation, ident) is None
        assert not frozen(db.get(CompositePreparation, old))
        left = db.get(ChartAlert, old_rule)
        assert (left.status, left.control_revision) == ("active", 1)
        untouched = db.get(ChartAlert, aligned)
        assert (untouched.control_revision, untouched.state) == (1, {})
        assert "switch_run_id" not in untouched.runtime
        run = db.scalar(select(MarketSwitchRun))
        assert (run.state, run.phase, run.attempts) == ("partial", "fence", 0)
        assert run.retention == {} and switch_runs.unlocked_runs() == []
        assert run.error_summary["stage"] == "fence"
        assert run.error_summary["completed_stages"] == ["alerts", "metrics"]
        note = db.scalar(select(Notification))
        assert note.kind == "system" and note.payload["run_id"] == run.id
        assert note.payload["stage"] == "fence" and note.payload["attempts"] == 0
        assert note.payload["counts"]["active_revision_id"] == old
        assert note.payload["errors"][0]["reason"] == "旧修订冻结失败"
    assert (counts(database, Notification), counts(database, Outbox)) == (1, 1)


def test_retries_keep_one_message_and_merge_distinct_errors(database, monkeypatch):
    composite, old, ident, _ = candidate(database, monkeypatch)
    freeze, metrics = switch_activation.freeze_previous, switch_activation.consolidate_metrics
    monkeypatch.setattr("alerts.composite_revisions.now_ms", lambda: STAMP)

    def freeze_fails(*args, **kwargs):
        raise ValueError("旧修订冻结失败")

    def metrics_fail(*args, **kwargs):
        raise ValueError("指标水位不一致")

    for failure, message in ((freeze_fails, "冻结失败"), (metrics_fail, "水位不一致"),
                             (freeze_fails, "冻结失败")):
        monkeypatch.setattr(switch_activation, "freeze_previous",
                            failure if failure is freeze_fails else freeze)
        monkeypatch.setattr(switch_activation, "consolidate_metrics",
                            failure if failure is metrics_fail else metrics)
        with pytest.raises(ValueError, match=message):
            with database.begin() as db:
                activate(db, composite, ident,
                         {"request_id": "retried", "expected_revision_id": old})
    with database() as db:
        assert db.scalar(select(func.count()).select_from(MarketSwitchRun)) == 1
        note = db.scalar(select(Notification))
        payload = note.payload
        # One logical message: the repeated stage merges, the new stage appends.
        assert [item["stage"] for item in payload["errors"]] == ["fence", "metrics"]
        assert [item["seen"] for item in payload["errors"]] == [2, 1]
        assert payload["attempts"] == 2 and payload["state"] == "partial"
        assert db.scalar(select(func.count()).select_from(Outbox).where(
            Outbox.notification_id == note.id)) == 1
        assert db.scalar(select(MarketSwitchRun.state)) == "partial"
    assert (counts(database, Notification), counts(database, Outbox)) == (1, 1)


# A real ask-side or coarser candidate cannot even be prepared: the collection
# identity and aggregate readers reject it first. The capability gate therefore
# guards the stored/reviewed capability and the fixture pair proves rejection.


def test_incompatible_source_is_rejected_without_touching_rules(database, monkeypatch):
    composite, old, ident, _ = candidate(database, monkeypatch)
    old_rule, aligned = rules(database, monkeypatch, composite, old, ident)
    # A real ask-side/coarse/old candidate cannot even be prepared, so the gate
    # is exercised with the fixture sources and the real comparison code.
    incompatibilities = switch_source.compare(
        switch_source.fixture("fixture-primary"),
        switch_source.fixture("fixture-incompatible"))

    def reject(*args, **kwargs):
        raise switch_source.SourceIncompatible(incompatibilities)

    monkeypatch.setattr(switch_source, "check", reject)
    monkeypatch.setattr("alerts.composite_revisions.now_ms", lambda: STAMP)
    with pytest.raises(ValueError, match="价格口径"):
        with database.begin() as db:
            activate(db, composite, ident,
                     {"request_id": "incompatible", "expected_revision_id": old})
    with database() as db:
        assert db.get(MarketComposite, composite).active_revision_id == old
        assert db.get(CompositeActivation, ident) is None
        assert not frozen(db.get(CompositePreparation, old))
        # No rule was migrated, paused or judged: no false crossing was emitted.
        assert db.get(ChartAlert, old_rule).status == "active"
        assert db.get(ChartAlert, aligned).status == "active"
        assert db.scalar(select(func.count()).select_from(CompositeJudgment)) == 0
        run = db.scalar(select(MarketSwitchRun))
        assert (run.state, run.phase) == ("failed", "capability")
        assert run.error_summary["stage"] == "capability"
        assert note_reasons(db) == incompatibilities["reasons"]
    assert (counts(database, Notification), counts(database, Outbox)) == (1, 1)


def note_reasons(db):
    return [item["reason"] for item in db.scalar(select(Notification)).payload["errors"]]


def test_fenced_revision_refuses_late_input_and_aggregate_commits(database, monkeypatch):
    composite, old, ident, _ = candidate(database, monkeypatch)
    monkeypatch.setattr("alerts.composite_revisions.now_ms", lambda: STAMP)
    with database.begin() as db:
        value = db.get(CompositePreparation, old).input_revision
        buckets = [(0, 60000)]
        stale = {"revision_id": old, "composite_id": composite,
                 "permission_scope": "workspace:default", "timeframe": "M1",
                 "input_revision": value, "offset": 0, "token": "stale-claim",
                 "buckets": buckets, "total": len(buckets)}
        assert claim(old, "M1") is None  # the fixture's tasks are consolidated
        activate(db, composite, ident, {"request_id": "fenced", "expected_revision_id": old})
    with pytest.raises(Fenced, match="已冻结"):
        with database.begin() as db:
            commit(stale, [])
    bars = counts(database, CompositeAggregateBar)
    recorded, applied = late_batch(database, old, 199980000)
    with database() as db:
        assert not [item for item in applied if item["revision_id"] == old]
        prep = db.get(CompositePreparation, old)
        assert prep.input_revision == value and frozen(prep)
        assert db.scalar(select(func.count()).select_from(CompositeAggregateBar)) == bars
        assert claim(old, "M1") is None
    assert aggregate_tick(old, "M1") is False
    # A frozen revision is never re-registered by the global backfill scan.
    with database.begin() as db:
        db.execute(delete(CompositeAggregateTask).where(CompositeAggregateTask.revision_id == old))
    with database() as db:
        claim()
        assert db.scalar(select(func.count()).select_from(CompositeAggregateTask).where(
            CompositeAggregateTask.revision_id == old)) == 0


def feed(database, revision_id, closes, *, now):
    """Contiguous confirmed minutes on the shared source, then its own waterline."""
    from test_composite_alerts import aggregate, live
    from test_fixed_indicators import add_tail

    rows = [minute(start, close=close, volume="3") for start, close in closes]
    add_tail(database, revision_id, rows, observed_at=now)
    aggregate(revision_id, "M1")
    live(database, revision_id, now, max(start for start, _ in closes) + 60000)


def test_relocation_never_replays_a_pre_switch_crossing(database, monkeypatch):
    from alerts.chart_alert_worker import evaluate
    from alerts.chart_data import FRAMES
    from alerts.storage import SignalRow
    from test_composite_alerts import aggregate, armed

    ident, composite, revision, seam, stamp = armed(database, monkeypatch)
    with database.begin() as db:
        assert evaluate(db, ident, now=stamp) == []  # initial baseline
    with database.begin() as db:
        old = db.get(CompositeRevision, revision)
        candidate_id = create(db, composite, {"request_id": "rebind-baseline",
            "expected_revision_id": revision, "history_version_id": old.history_version_id,
            "mapping_id": old.mapping_id, "seam": old.seam + 60000,
            "allow_non_day_boundary": True, "reason": "显式重新绑定运行基线"}).id
    contracts.prepared(database, candidate_id)
    # One real crossing, then a dip the switched rule still carries as baseline.
    feed(database, revision, [(seam + 600000, "1.119")], now=seam + 670000)
    with database.begin() as db:
        assert len(evaluate(db, ident, now=seam + 670000)) == 1
    feed(database, revision,
         [(seam + minute_, "1.110") for minute_ in range(660000, 1260000, 60000)],
         now=seam + 1270000)
    with database.begin() as db:
        assert evaluate(db, ident, now=seam + 1270000) == []
    assert counts(database, SignalRow) == 1
    for frame in FRAMES:
        aggregate(candidate_id, frame)
    monkeypatch.setattr("alerts.composite_revisions.now_ms", lambda: seam + 1300000)
    with database.begin() as db:
        activate(db, composite, candidate_id,
                 {"request_id": "rebind-activation", "expected_revision_id": revision})
    with database() as db:
        alert = db.get(ChartAlert, ident)
        assert (alert.version, alert.state, alert.effective_at) == (2, {}, seam + 1260000)
        assert db.scalar(select(ChartAlertVersion.market_identity).where(
            ChartAlertVersion.alert_id == ident,
            ChartAlertVersion.version == 2))["composite_revision_id"] == candidate_id
    # The last bar before the switch closed below the level it would need to cross
    # from: reading the same data as a new revision must establish a baseline.
    with database.begin() as db:
        assert evaluate(db, ident, now=seam + 1270000) == []
        assert db.get(ChartAlert, ident).state["sequence"] == seam + 1260000
    assert counts(database, SignalRow) == 1
    # A crossing after the boundary fires exactly once, on the new revision.
    feed(database, candidate_id, [(seam + 1260000, "1.110")], now=seam + 1330000)
    with database.begin() as db:
        assert evaluate(db, ident, now=seam + 1330000) == []
    feed(database, candidate_id, [(seam + 1320000, "1.119")], now=seam + 1390000)
    with database.begin() as db:
        assert len(evaluate(db, ident, now=seam + 1390000)) == 1
        assert evaluate(db, ident, now=seam + 1390000) == []  # never duplicated
        signal = db.scalar(select(SignalRow).order_by(SignalRow.occurred_at.desc()))
        assert signal.evidence["market_identity"]["composite_revision_id"] == candidate_id
    assert counts(database, SignalRow) == 2


def test_relocatable_requires_a_published_period_and_a_caught_up_waterline(database, monkeypatch):
    from alerts.chart_alert_service import AlertConfig
    from alerts.composite_alerts import relocatable

    composite, old, ident, _ = candidate(database, monkeypatch)
    with database.begin() as db:
        previous, target = db.get(CompositeRevision, old), db.get(CompositeRevision, ident)
        prep = db.get(CompositePreparation, ident)
        config_ = AlertConfig.model_validate(config(composite).model_dump(mode="json"))
        bound = {"seam_policy": config_.seam_policy}
        assert relocatable(db, previous, target, config_, bound,
            input_revision=prep.input_revision) == (True, None)
        task = db.get(CompositeAggregateTask, (ident, "M1"))
        task.applied_input_revision = prep.input_revision - 1
        ready, reason = relocatable(db, previous, target, config_, bound,
            input_revision=prep.input_revision)
        assert not ready and "M1" in reason and "水位" in reason


def test_rule_the_target_cannot_serve_is_paused_and_reported(database, monkeypatch):
    from alerts import composite_alerts

    composite, old, ident, _ = candidate(database, monkeypatch)
    with database.begin() as db:
        rule = create_alert(db, "switch-blocked-rule", config(composite), at=STAMP).id
    monkeypatch.setattr("alerts.composite_revisions.now_ms", lambda: STAMP)
    # Readiness already guarantees every frame, so the guard's negative branch is
    # injected here; its own predicate is asserted by the test above.
    original = composite_alerts.relocatable
    monkeypatch.setattr(composite_alerts, "relocatable",
        lambda db, previous_, target_, config_, bound_, **kwargs: (
            False, "目标修订缺少 M15 固定周期产物"))
    with database.begin() as db:
        activation = activate(db, composite, ident,
                              {"request_id": "blocked", "expected_revision_id": old})
        run = db.scalar(select(MarketSwitchRun))
        assert (run.state, run.phase) == ("succeeded", "activated")
        assert activation.evidence["switch"]["alerts"]["paused"] == [
            {"id": rule, "revision_id": old}]
        assert activation.evidence["switch"]["alerts"]["rebound"] == []
    monkeypatch.setattr(composite_alerts, "relocatable", original)
    with database() as db:
        row = db.get(ChartAlert, rule)
        assert (row.status, row.health, row.version) == ("paused", "blocked", 1)
        assert "M15" in row.health_reason and row.runtime["demand_hold"] == "stale_input"
        assert db.get(MarketComposite, composite).active_revision_id == ident
        assert db.scalar(select(Audit.id).where(Audit.kind == "chart_alert_paused",
            Audit.details["alert_id"].as_string() == rule)) is not None
        payload = db.scalar(select(Notification)).payload
        assert (payload["state"], payload["counts"]["paused"], payload["counts"]["rules"]) == (
            "succeeded", 1, 1)
        assert payload["counts"]["active_revision_id"] == ident
        assert payload["errors"] == [{"key": "alerts|" + rule + "|rule_not_relocatable",
            "stage": "alerts", "scope": rule, "type": "rule_not_relocatable",
            "reason": "目标修订缺少 M15 固定周期产物",
            "at": STAMP, "last_at": STAMP, "seen": 1}]



def test_forward_history_version_rebinds_without_pausing(database, monkeypatch):
    """Only the history version moves: same calendar and basis, so relocate."""
    from test_composite_definitions import publish

    composite, old, body = contracts.request(database, monkeypatch)
    new_version = publish(database, end=172980000)
    with database.begin() as db:
        parent = db.get(CompositeRevision, old)
        ident = create(db, composite, {**body, "request_id": "history-advance",
            "history_version_id": new_version, "seam": parent.seam + 60000,
            "allow_non_day_boundary": True, "reason": "同口径历史版本前移"}).id
        assert db.get(HistoryVersion, new_version).end > db.get(
            HistoryVersion, parent.history_version_id).end
    contracts.prepared(database, ident)
    monkeypatch.setattr("alerts.composite_alerts.require_live_eligibility",
                        lambda *args, **kwargs: None)
    with database.begin() as db:
        rule = create_alert(db, "advance-rule", config(composite), at=STAMP).id
        bound_before = dict(db.scalar(select(ChartAlertVersion.market_identity).where(
            ChartAlertVersion.alert_id == rule, ChartAlertVersion.version == 1)))
    monkeypatch.setattr("alerts.composite_revisions.now_ms", lambda: STAMP)
    with database.begin() as db:
        activation = activate(db, composite, ident,
                             {"request_id": "advance", "expected_revision_id": old})
        assert activation.evidence["switch"]["alerts"]["paused"] == []
        assert [item["id"] for item in activation.evidence["switch"]["alerts"]["rebound"]] == [rule]
    with database() as db:
        row = db.get(ChartAlert, rule)
        bound = dict(db.scalar(select(ChartAlertVersion.market_identity).where(
            ChartAlertVersion.alert_id == rule, ChartAlertVersion.version == 2)))
        assert (row.status, row.version, row.state) == ("active", 2, {})
        assert bound["composite_revision_id"] == ident
        assert bound["history_version_id"] == new_version != bound_before["history_version_id"]
        assert db.scalar(select(ChartAlertVersion.market_identity).where(
            ChartAlertVersion.alert_id == rule, ChartAlertVersion.version == 1)) == bound_before
    assert counts(database, Notification) == 0


def test_calendar_change_pauses_the_running_rule(database, monkeypatch):
    """A ny17 -> utc0 activation moves bucket boundaries: never relocate a rule."""
    from alerts.aggregation_policy import change_aggregation
    from alerts.composite_definitions import save_mapping
    from alerts.history_artifacts import artifact_tick
    from alerts.history_versions import import_page
    from alerts.storage import MarketCatalog
    from test_composite_definitions import PROOF
    from test_history_versions import Adapter

    composite, old, body = contracts.request(database, monkeypatch)
    with database.begin() as db:
        parent = db.get(HistoryVersion, body["history_version_id"])
        destination, _, derived = change_aggregation(db, parent.dataset_id, "utc0",
            version_id=parent.id)
        rule = create_alert(db, "calendar-rule", config(composite), at=STAMP).id
    while import_page(Adapter([]), version_id=derived.id):
        with database() as db:
            if db.get(HistoryVersion, derived.id).status == "published":
                break
    while artifact_tick(derived.id):
        pass
    with database.begin() as db:
        catalog = db.scalar(select(MarketCatalog.id).where(MarketCatalog.source == "oanda"))
        mapping = save_mapping(db, destination.id, catalog, PROOF)
        ident = create(db, composite, {**body, "request_id": "calendar-switch",
            "history_version_id": derived.id, "mapping_id": mapping.id, "seam": 86400000,
            "allow_non_day_boundary": False}).id
    contracts.prepared(database, ident)
    monkeypatch.setattr("alerts.composite_revisions.now_ms", lambda: STAMP)
    with database.begin() as db:
        activation = activate(db, composite, ident,
                              {"request_id": "calendar", "expected_revision_id": old})
        # Geometry and judgment baseline cannot be moved across a calendar change.
        assert [item["id"] for item in activation.evidence["switch"]["alerts"]["paused"]] == [rule]
        assert activation.evidence["switch"]["alerts"]["rebound"] == []
        run = db.scalar(select(MarketSwitchRun))
        assert (run.state, run.phase) == ("succeeded", "activated")
        assert db.get(MarketComposite, composite).active_revision_id == ident
    with database() as db:
        row = db.get(ChartAlert, rule)
        assert (row.status, row.version, row.health) == ("paused", 1, "blocked")
        assert "utc0" in row.health_reason and "ny17" in row.health_reason
        assert db.scalar(select(ChartAlertVersion.market_identity).where(
            ChartAlertVersion.alert_id == rule, ChartAlertVersion.version == 1)
        )["composite_revision_id"] == old
        payload = db.scalar(select(Notification)).payload
        assert (payload["state"], payload["counts"]["paused"], payload["counts"]["rules"]) == (
            "succeeded", 1, 1)
        assert "日历" in payload["errors"][0]["reason"]


def standby_mapping(database, old, *, name="standby"):
    """A second reviewed live mapping: same identity, independent target rows."""
    mapping_id = ("RM:" + name).ljust(64, "0")
    with database.begin() as db:
        revision = db.get(CompositeRevision, old)
        history = db.get(HistoryVersion, revision.history_version_id)
        source = db.get(RealtimeMapping, revision.mapping_id)
        original = db.get(MarketDataset, source.target_dataset_id)
        instrument = db.get(Instrument, original.instrument_id)
        db.add(Instrument(id="V:" + name, label=instrument.label, source=instrument.source,
            symbol=instrument.symbol, basis=instrument.basis, calendar=instrument.calendar,
            calendar_profile=instrument.calendar_profile, precision=instrument.precision))
        db.add(MarketDataset(id="MD:" + name, instrument_id="V:" + name,
            logical_symbol=original.logical_symbol, identity=dict(original.identity),
            volume_kind=original.volume_kind, volume_unit=original.volume_unit))
        db.add(RealtimeMapping(id=mapping_id, dataset_id=history.dataset_id,
            target_dataset_id="MD:" + name, permission_scope="workspace:default",
            match=dict(source.match)))
    return mapping_id


def test_shadow_verdict_pauses_rules_the_candidate_cannot_move(database, monkeypatch):
    from alerts import baseline_shadow
    from alerts import switch_runs as runs

    composite, old, ident, _ = candidate(database, monkeypatch)
    monkeypatch.setattr("alerts.composite_alerts.require_live_eligibility",
                        lambda *args, **kwargs: None)
    with database.begin() as db:
        blocked = create_alert(db, "shadow-blocked", config(composite), at=STAMP).id
        movable = create_alert(db, "shadow-movable", config(composite), at=STAMP).id
    with database.begin() as db:
        run = runs.start(baseline_shadow.KIND, composite_id=composite,
                         previous_revision_id=old, scheduled_for=STAMP)
        runs.record_target(run["id"], ident, previous_revision_id=old)
        runs.record_shadow(run["id"], {"schema": baseline_shadow.SCHEMA, "paused_rules": [
            {"alert_id": blocked, "will_pause": True, "alert_version": 1,
             "reasons": [{"code": "geometry_not_relocatable",
                          "detail": "候选聚合日历与规则绑定的修订不同，已有时点无法按原几何重定位"}]},
            {"alert_id": movable, "will_pause": False, "reasons": []}]})
    monkeypatch.setattr("alerts.composite_revisions.now_ms", lambda: STAMP)
    with database.begin() as db:
        activation = activate(db, composite, ident,
                              {"request_id": "shadow", "expected_revision_id": old})
        assert [item["id"] for item in activation.evidence["switch"]["alerts"]["paused"]] == [blocked]
        assert [item["id"] for item in activation.evidence["switch"]["alerts"]["rebound"]] == [movable]
    with database() as db:
        paused = db.get(ChartAlert, blocked)
        assert (paused.status, paused.version) == ("paused", 1)
        assert "无法按原几何重定位" in paused.health_reason
        assert (db.get(ChartAlert, movable).status, db.get(ChartAlert, movable).version) == (
            "active", 2)
        payload = db.scalar(select(Notification)).payload
        assert (payload["counts"]["paused"], payload["counts"]["rules"]) == (1, 2)
        assert payload["errors"][0]["type"] == "rule_paused_by_shadow"


def test_merged_new_error_requeues_the_same_outbox_row(database):
    from alerts import switch_notice
    from alerts import switch_runs as runs

    with database.begin() as db:
        run = runs.start("switch_notice_test", composite_id="c1", scheduled_for=STAMP)
    def report(stage, reason):
        with database.begin() as db:
            return switch_notice.record(db, run=runs.get(run["id"]), stage=stage,
                reasons=[{"stage": stage, "scope": "switch", "type": "ValueError",
                          "reason": reason}],
                counts={"sources": 1, "rules": 0, "paused": 0}, now=STAMP)
    first = report("fence", "旧修订冻结失败")
    assert (first["created"], first["requeued"], first["outbox_rows"]) == (True, False, 1)
    with database.begin() as db:
        row = db.scalar(select(Outbox))
        row.status, row.attempts, row.next_at = "accepted", 1, STAMP - 60000
    repeated = report("fence", "旧修订冻结失败")
    assert (repeated["new_errors"], repeated["requeued"]) == (0, False)
    with database() as db:
        row = db.scalar(select(Outbox))
        assert (row.status, row.attempts, row.next_at) == ("accepted", 1, STAMP - 60000)
        note = db.scalar(select(Notification))
        assert [item["seen"] for item in note.payload["errors"]] == [2]
    merged = report("metrics", "指标水位不一致")
    assert (merged["new_errors"], merged["requeued"], merged["outbox_rows"]) == (1, True, 1)
    with database() as db:
        row = db.scalar(select(Outbox))
        assert (row.status, row.attempts, row.next_at, row.lease_until) == (
            "pending", 1, STAMP, None)
        assert db.scalar(select(func.count()).select_from(Outbox)) == 1
        assert db.scalar(select(func.count()).select_from(Notification)) == 1
        assert len(db.scalar(select(Notification)).payload["errors"]) == 2
    queued = report("alerts", "规则不可迁移")
    assert (queued["new_errors"], queued["requeued"]) == (1, False)  # already pending
    with database() as db:
        row = db.scalar(select(Outbox))
        assert (row.attempts, row.next_at) == (1, STAMP)
        assert db.scalar(select(func.count()).select_from(Outbox)) == 1


def test_held_pause_on_a_running_revision_keeps_its_target(database, monkeypatch):
    from alerts.market_usage import composite_targets

    composite, old, ident, _ = candidate(database, monkeypatch)
    with database.begin() as db:
        rule = create_alert(db, "held-live-rule", config(composite), at=STAMP).id
        alert = db.get(ChartAlert, rule)
        alert.status, alert.runtime = "paused", {"demand_hold": "stale_input"}
        target = db.get(RealtimeMapping, db.get(CompositeRevision, old).mapping_id).target_dataset_id
        internal = db.get(MarketComposite, composite).instrument_id
        assert composite_targets(db, {internal}) == {target}


def test_frozen_held_pause_drops_its_own_target_after_a_source_switch(database, monkeypatch):
    from alerts.market_usage import composite_targets

    composite, old, body = contracts.request(database, monkeypatch)
    mapping = standby_mapping(database, old)
    with database.begin() as db:
        ident = create(db, composite, {**body, "request_id": "held-switch",
                                       "mapping_id": mapping}).id
    contracts.prepared(database, ident)
    frozen_rule, live_rule = rules(database, monkeypatch, composite, old, ident)
    monkeypatch.setattr("alerts.composite_revisions.now_ms", lambda: STAMP)
    with database.begin() as db:
        activate(db, composite, ident, {"request_id": "held", "expected_revision_id": old})
    with database.begin() as db:
        for rule in (frozen_rule, live_rule):
            alert = db.get(ChartAlert, rule)
            alert.status, alert.control_revision = "paused", alert.control_revision + 1
            alert.runtime = {**alert.runtime, "demand_hold": "stale_input"}
        internal = db.get(MarketComposite, composite).instrument_id
        old_target = db.get(RealtimeMapping, db.get(CompositeRevision, old).mapping_id).target_dataset_id
        live_target = db.get(RealtimeMapping, mapping).target_dataset_id
        assert old_target != live_target
        # The frozen revision ends its own demand; the paused rule on the running
        # revision still contributes exactly its own target.
        assert composite_targets(db, {internal}) == {live_target}
