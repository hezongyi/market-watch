"""Maintenance completion, exact default mapping and lossless automatic activation."""

import pytest
from alerts import managed_rollover as rollover
from alerts import switch_schedule
from alerts.composite_definitions import save_mapping
from alerts.composite_inputs import frozen
from alerts.config import settings
from alerts.managed_continuation import default_key
from alerts.storage import (
    ChartAlert,
    CompositeActivation,
    CompositePreparation,
    CompositeRevision,
    HistoryArtifact,
    HistoryRun,
    HistoryVersion,
    MarketCatalog,
    MarketComposite,
    MarketDataset,
    MarketSwitchRun,
    Preference,
)
from sqlalchemy import func, select
from test_composite_chart import populated
from test_composite_definitions import PROOF, publish
from test_composite_revisions import prepared
from test_switch_activation import rules

STAMP = 200010000


def completed(database, version_id):
    """Explicit completed-maintenance fixture, separate from supplier acceptance."""
    with database.begin() as db:
        version = db.get(HistoryVersion, version_id)
        db.add(HistoryRun(version_id=version_id, dataset_id=version.dataset_id,
            request_id=version_id, request_hash="a" * 64, kind="manual",
            refresh_start=version.start, refresh_end=version.end,
            desired_state="running", completed_at=STAMP))


def setup(database, monkeypatch):
    monkeypatch.setattr(settings, "managed_rollover_enabled", True)
    monkeypatch.setattr(settings, "switch_auto_activate_enabled", True)
    monkeypatch.setattr(rollover, "now_ms", lambda: STAMP)
    composite, active, seam = populated(database, monkeypatch)
    with database.begin() as db:
        head = db.get(CompositeRevision, active)
        dataset_id = db.get(MarketComposite, composite).dataset_id
        db.add(Preference(key=default_key(dataset_id), value={"mapping_id": head.mapping_id}))
    version = publish(database, end=198960000)
    return composite, active, version, seam


def candidate(database, monkeypatch):
    composite, active, version, seam = setup(database, monkeypatch)
    completed(database, version)
    selection, ident, run_id = rollover._candidate(composite)
    prepared(database, ident)
    with database.begin() as db:
        # Copy existing confirmed source minutes through the public fanout path.
        from alerts.composite_inputs import apply_minutes
        from alerts.source_registry import collection_identity
        from alerts.storage import CompositeMinute, RealtimeMapping
        revision = db.get(CompositeRevision, active)
        mapping = db.get(RealtimeMapping, revision.mapping_id)
        target = db.get(MarketDataset, mapping.target_dataset_id)
        minutes = list(db.scalars(select(CompositeMinute).where(CompositeMinute.revision_id == active)))
        apply_minutes(db, {"source_id": collection_identity(target.identity).key,
            "minutes": [{"start": row.start, "revision_id": row.source_revision_id} for row in minutes]},
            revision_id=ident, reason="test_catchup")
        rollover.refresh_tail(db, db.get(CompositeRevision, ident))
    prepared(database, ident)
    return composite, active, version, ident, run_id


def test_published_without_completed_maintenance_never_queues_a_candidate(database, monkeypatch):
    composite, active, version, _ = setup(database, monkeypatch)
    assert rollover.reconcile(composite)["status"] == "current"
    with database() as db:
        assert rollover.successful_version(db, db.get(MarketComposite, composite).dataset_id) is None
        assert db.scalar(select(func.count()).select_from(CompositeRevision)) == 1
    completed(database, version)
    assert rollover.reconcile(composite, budget=0)["status"] == "preparing"
    assert rollover.reconcile(composite, budget=0)["status"] == "preparing"
    with database() as db:
        assert db.scalar(select(func.count()).select_from(CompositeRevision)) == 2
        assert db.scalar(select(func.count()).select_from(MarketSwitchRun)) == 1
        assert db.get(MarketComposite, composite).active_revision_id == active


@pytest.mark.parametrize("state", ["running", "failed", "cancelled"])
def test_incomplete_or_failed_maintenance_is_ineligible(database, monkeypatch, state):
    composite, _, version, _ = setup(database, monkeypatch)
    completed(database, version)
    with database.begin() as db:
        run = db.get(HistoryRun, version)
        if state == "running":
            run.completed_at = None
        else:
            run.desired_state = state
    assert rollover.reconcile(composite)["status"] == "current"


def test_required_unavailable_artifact_cannot_take_over(database, monkeypatch):
    composite, _, version, _ = setup(database, monkeypatch)
    completed(database, version)
    with database.begin() as db:
        artifact = db.scalar(select(HistoryArtifact).where(
            HistoryArtifact.version_id == version, HistoryArtifact.timeframe == "M1"))
        # A damaged/unavailable artifact is not a successful trigger. SQL bypass
        # of the immutable published contract is deliberately fixture-only.
        from sqlalchemy import update
        db.execute(update(HistoryArtifact).where(HistoryArtifact.id == artifact.id)
                   .values(status="unavailable"))
    assert rollover.reconcile(composite)["status"] == "current"


def test_saved_mapping_is_used_even_when_another_reviewed_mapping_exists(database, monkeypatch):
    composite, _, version, _ = setup(database, monkeypatch)
    completed(database, version)
    with database.begin() as db:
        dataset = db.get(MarketComposite, composite).dataset_id
        original = db.get(Preference, default_key(dataset)).value["mapping_id"]
        catalog = db.scalar(select(MarketCatalog.id).where(MarketCatalog.source == "oanda"))
        alternative = save_mapping(db, dataset, catalog, {**PROOF, "rationale": "A separate reviewed mapping"})
        assert alternative.id != original
        assert rollover.plan(db, composite)["mapping_id"] == original
        db.get(Preference, default_key(dataset)).value = {"mapping_id": alternative.id}
    assert rollover.reconcile(composite)["status"] == "deferred"


def test_candidate_catches_old_tail_and_activates_once_without_changing_identity(database, monkeypatch):
    composite, active, version, ident, _ = candidate(database, monkeypatch)
    result = rollover.reconcile(composite, budget=16)
    assert result["status"] == "ready", result
    activation = switch_schedule.activation_cycle()
    assert [item["status"] for item in activation["candidates"]] == ["activated"], activation
    with database() as db:
        assert db.get(MarketComposite, composite).active_revision_id == ident
        assert db.get(CompositeRevision, ident).history_version_id == version
        assert frozen(db.get(CompositePreparation, active))
        assert db.get(CompositePreparation, ident).confirmed_end >= db.get(CompositePreparation, active).confirmed_end
        assert db.scalar(select(func.count()).select_from(CompositeActivation)) == 1
    assert rollover.reconcile(composite)["status"] == "current"
    assert switch_schedule.activation_cycle()["candidates"] == []


def test_fixed_price_alert_defers_auto_activation_and_remains_active(database, monkeypatch):
    composite, active, _, ident, _ = candidate(database, monkeypatch)
    old_rule, _ = rules(database, monkeypatch, composite, active, ident, fixed=True)
    result = rollover.reconcile(composite, budget=16)
    assert result["status"] == "deferred", result
    assert "固定价格告警" in result["reason"]
    cycle = switch_schedule.activation_cycle()
    assert not cycle["candidates"] and cycle["skipped"]
    with database() as db:
        assert db.get(ChartAlert, old_rule).status == "active"
        assert not frozen(db.get(CompositePreparation, active))
        assert db.get(MarketComposite, composite).active_revision_id == active
        assert db.scalar(select(func.count()).select_from(CompositeActivation)) == 0


def test_new_fixed_rule_after_preflight_is_checked_again_at_activation(database, monkeypatch):
    composite, active, _, ident, _ = candidate(database, monkeypatch)
    assert rollover.reconcile(composite, budget=16)["status"] == "ready"
    old_rule, _ = rules(database, monkeypatch, composite, active, ident, fixed=True)
    cycle = switch_schedule.activation_cycle()
    assert cycle["candidates"] == [] and cycle["skipped"]
    with database() as db:
        assert db.get(ChartAlert, old_rule).status == "active"
        assert db.get(MarketComposite, composite).active_revision_id == active
        assert db.scalar(select(func.count()).select_from(MarketSwitchRun).where(
            MarketSwitchRun.kind == "revision_activation")) == 0


def test_late_confirmation_invalidates_candidate_activation_input(database, monkeypatch):
    composite, active, _, ident, _ = candidate(database, monkeypatch)
    assert rollover.reconcile(composite, budget=16)["status"] == "ready"
    with database.begin() as db:
        old = db.get(CompositePreparation, active)
        old.confirmed_end = db.get(CompositePreparation, ident).cutoff + 60000
    cycle = switch_schedule.activation_cycle()
    assert not cycle["candidates"] and cycle["skipped"]
    with database.begin() as db:
        prep = db.get(CompositePreparation, ident)
        rollover.refresh_tail(db, db.get(CompositeRevision, ident))
        assert prep.status == "pending"
        assert prep.state["managed_tail_cutoff"] == db.get(CompositePreparation, active).confirmed_end
        assert not prep.state.get("activation_ready")


def test_disabling_realtime_or_automation_blocks_a_ready_candidate(database, monkeypatch):
    composite, active, _, ident, _ = candidate(database, monkeypatch)
    assert rollover.reconcile(composite, budget=16)["status"] == "ready"
    from alerts.realtime_switch import set_enabled
    with database.begin() as db:
        dataset = db.get(MarketDataset, db.get(MarketComposite, composite).dataset_id)
        set_enabled(db, dataset.instrument_id, False, now=STAMP)
    assert not switch_schedule.activation_cycle()["candidates"]
    monkeypatch.setattr(settings, "managed_rollover_enabled", False)
    assert rollover.cycle()["composites"] == []
    assert not switch_schedule.activation_targets()[0]
    with database() as db:
        assert db.get(MarketComposite, composite).active_revision_id == active
