"""Payload reclamation blocks durable references and preserves shared content."""

import pytest
from alerts import api
from alerts.data_center import dataset_detail
from alerts.history_artifacts import artifact_tick, request_artifacts
from alerts.history_maintenance import configure, create_run
from alerts.history_replay import create_replay
from alerts.history_retention import reclaim, references
from alerts.history_versions import import_page, snapshot_rows, version_report
from alerts.storage import (
    ChartWorkspace,
    DatasetMaintenance,
    HistoryArtifact,
    HistoryChunk,
    HistoryReclamation,
    HistoryVersion,
    Instrument,
    MarketDataset,
    SourceBlob,
    SourceFetch,
)
from fastapi.testclient import TestClient
from sqlalchemy import delete, func, select
from test_history_maintenance import Adapter
from test_market_contracts import identity
from test_market_datasets import register


def prepared(database, frames=("M1", "H4")):
    with database.begin() as db:
        inst = register(db)
        configure(db, identity().key, target_start=0, timeframes=list(frames))
        ident = create_run(db, identity().key, end=120000, request_id="initial").id
        instrument = inst.id
    import_page(Adapter(), version_id=ident)
    while artifact_tick(ident):
        pass
    with database.begin() as db:
        plan = db.get(DatasetMaintenance, identity().key)
        plan.paused = plan.archived = True
    return ident, instrument


def test_reclaim_preserves_identity_manifest_and_retries_but_not_old_payload(database):
    ident, _ = prepared(database)
    with database.begin() as db:
        manifest = db.get(HistoryVersion, ident).manifest
        assert references(db, identity().key)["can_reclaim"]
        result = reclaim(db, identity().key, "clear")
        assert result["versions"] == 1 and result["deleted"]["market_history_chunks"] == 1
        assert result["deleted"]["market_source_blobs"] == 0  # Live acquisition cache retains it.
    with database.begin() as db:
        assert db.get(MarketDataset, identity().key)
        assert db.get(HistoryVersion, ident).manifest == manifest
        assert not version_report(db, ident)["payload_available"]
        assert db.get(HistoryReclamation, ident)
        assert db.scalar(select(func.count()).select_from(HistoryArtifact)) == 0
        assert dataset_detail(db, identity().key)["usable_timeframes"] == []
        assert reclaim(db, identity().key, "clear") == result
        with pytest.raises(ValueError, match="回收"):
            list(snapshot_rows(db, ident))
        with pytest.raises(ValueError, match="回收"):
            request_artifacts(db, db.get(HistoryVersion, ident), ["M1"])
        plan = db.get(DatasetMaintenance, identity().key)
        plan.archived = plan.paused = False
        child = create_run(db, identity().key, end=180000, request_id="new").id
        assert db.get(HistoryVersion, child).manifest["maintenance"]["parent_version"] is None
        assert reclaim(db, identity().key, "clear") == result  # Does not delete the new task.
    import_page(Adapter(), version_id=child)
    while artifact_tick(child):
        pass
    with database.begin() as db:
        assert dataset_detail(db, identity().key)["latest_version_id"] == child
        assert len(list(snapshot_rows(db, child))) == 3
        assert not version_report(db, ident)["payload_available"]


def test_saved_replay_and_workspace_block_reclamation(database):
    ident, instrument = prepared(database, frames=("M1", "H4", "D1"))
    with database.begin() as db:
        create_replay(db, db.get(Instrument, instrument), ident, "M1", 0, 120000)
        db.add(ChartWorkspace(name="saved", document={"panels": [{"instrument": instrument}]}))
    with database.begin() as db:
        report = references(db, identity().key)
        assert {r["kind"] for r in report["items"]} >= {"replay", "workspace"}
        with pytest.raises(ValueError, match="引用"):
            reclaim(db, identity().key, "blocked")
        assert len(list(snapshot_rows(db, ident))) == 2


def test_completed_maintenance_with_new_pending_period_still_blocks_reclaim(database):
    ident, _ = prepared(database)
    with database.begin() as db:
        request_artifacts(db, db.get(HistoryVersion, ident), ["D1"])
        assert any(r["kind"] == "task" for r in references(db, identity().key)["items"])
        with pytest.raises(ValueError, match="活动任务"):
            reclaim(db, identity().key, "blocked")


def test_reclaim_keeps_source_content_referenced_by_another_calendar(database):
    from alerts.aggregation_policy import change_aggregation
    from alerts.history_derivation import derive_page

    ident, _ = prepared(database)
    with database.begin() as db:
        target, _, child = change_aggregation(db, identity().key, "utc0", version_id=ident)
        other_id, child_id = target.id, child.id
    while derive_page(child_id):
        pass
    while artifact_tick(child_id):
        pass
    with database.begin() as db:
        # Explicit derivation provenance is itself a durable dependency.
        with pytest.raises(ValueError, match="引用"):
            reclaim(db, identity().key, "blocked")
        assert len(list(snapshot_rows(db, child_id))) == 2
        assert references(db, other_id)["requires_archive"]


def test_source_cache_is_retained_and_unreachable_blob_is_reclaimed(database):
    ident, _ = prepared(database)
    with database.begin() as db:
        blob = db.scalar(select(HistoryChunk.content_id).where(HistoryChunk.version_id == ident))
        assert db.get(SourceBlob, blob)
        # Removing only this test's acquisition cache makes its content unreachable.
        db.execute(delete(SourceFetch).where(SourceFetch.content_id == blob))
        result = reclaim(db, identity().key, "clear")
        assert result["deleted"]["market_source_blobs"] == 1
    with database.begin() as db:
        assert db.get(SourceBlob, blob) is None


def test_shared_blob_without_cache_remains_reachable_from_independent_dataset(database):
    ident, _ = prepared(database)
    alternate = identity(calendar_version="another-fixed-rule")
    with database.begin() as db:
        register(db, alternate)
        configure(db, alternate.key, target_start=0, timeframes=["M1"])
        other = create_run(db, alternate.key, end=120000, request_id="other").id
    import_page(Adapter(), version_id=other)
    while artifact_tick(other):
        pass
    with database.begin() as db:
        content_ids = set(db.scalars(select(HistoryChunk.content_id)))
        assert len(content_ids) == 1
        db.execute(delete(SourceFetch).where(SourceFetch.content_id.in_(content_ids)))
        assert reclaim(db, identity().key, "clear")["deleted"]["market_source_blobs"] == 0
    with database.begin() as db:
        assert len(list(snapshot_rows(db, other))) == 2


def test_reclaim_api_requires_archive_and_rechecks_references(database):
    ident, _ = prepared(database)
    with database.begin() as db:
        db.get(DatasetMaintenance, identity().key).archived = False
    api.app.dependency_overrides[api.authenticated] = lambda: "test"
    try:
        with TestClient(api.app) as client:
            base = f"/api/market-data/datasets/{identity().key}"
            assert client.post(base + "/reclaim", json={"request_id": "clear"}).status_code == 409
            assert client.post(base + "/maintenance/control", json={"action": "archive"}).status_code == 200
            assert client.get(base + "/references").json()["can_reclaim"]
            assert client.post(base + "/reclaim", json={"request_id": "clear"}).status_code == 200
            assert not client.get(f"/api/market-data/versions/{ident}").json()["payload_available"]
    finally:
        api.app.dependency_overrides.clear()


def test_new_workspace_cannot_reference_reclaimed_version_after_precheck(database):
    ident, instrument = prepared(database)
    with database.begin() as db:
        reclaim(db, identity().key, "clear")
    with pytest.raises(ValueError, match="回收"):
        with database.begin() as db:
            db.add(ChartWorkspace(name="stale", document={"instrument": instrument, "version_id": ident}))
    # Plain series references can remain saved even when history isn't ready.
    with database.begin() as db:
        db.add(ChartWorkspace(name="identity remains", document={"instrument": instrument}))


def test_reclaimed_tombstone_cannot_be_removed_or_changed_by_runtime(database):
    ident, _ = prepared(database)
    with database.begin() as db:
        reclaim(db, identity().key, "clear")
    with pytest.raises(ValueError, match="deleted"):
        with database.begin() as db:
            db.delete(db.get(HistoryReclamation, ident))
    with pytest.raises(ValueError, match="immutable"):
        with database.begin() as db:
            db.get(HistoryReclamation, ident).request_id = "changed"
