"""Native checkpoint content remains reachable independently of source cache."""

import pytest
from alerts.chart_api import DataQuery, data_sync
from alerts.history_maintenance import configure, create_run
from alerts.history_retention import reclaim, references
from alerts.history_versions import import_page
from alerts.source_registry import link_frame_source
from alerts.storage import (
    ChartWorkspace,
    DatasetMaintenance,
    HistoryChunk,
    HistoryFrameRun,
    SourceBlob,
    SourceFetch,
)
from sqlalchemy import delete, select
from test_history_modes import mode_identity, native_identity, register_mode
from test_native_history_archive import Adapter, day, drain, prepare, run, stamp


def test_reclaim_removes_native_pages_but_protects_another_checkpoint(database):
    dataset = prepare(database)
    adapter = Adapter({"D1": [day("2024-01-02")]})
    version = run(database, dataset, "2024-01-05", adapter)
    alternate = mode_identity(calendar_version="independent-source-date-v1")
    with database.begin() as db:
        original = db.get(HistoryFrameRun, (version, "D1"))
        pages = set(original.facts["pages"])
        assert pages
        chunks = set(db.scalars(select(HistoryChunk.content_id).where(HistoryChunk.version_id == version)))
        other, _ = register_mode(db, alternate)
        link_frame_source(db, other, "D1", native_identity("D1", alternate))
        configure(db, other.id, target_start=stamp("2023-12-01"), timeframes=["D1"])
        pending = create_run(db, other.id, end=stamp("2024-01-05"), request_id="shared-page").id
    assert import_page(adapter, version_id=pending)
    with database.begin() as db:
        pending_pages = set(db.get(HistoryFrameRun, (pending, "D1")).facts["pages"])
        assert pages == pending_pages
        db.execute(delete(SourceFetch).where(SourceFetch.content_id.in_(pages | chunks)))
        plan = db.get(DatasetMaintenance, dataset)
        plan.paused = plan.archived = True
        assert references(db, dataset)["can_reclaim"]
        result = reclaim(db, dataset, "native-pages")
        assert result["deleted"]["market_history_frame_runs"] == 1
        assert result["deleted"]["market_source_blobs"] == len(chunks - pending_pages)
    with database.begin() as db:
        assert db.get(HistoryFrameRun, (version, "D1")) is None
        assert all(db.get(SourceBlob, ident) for ident in pending_pages)
        assert all(db.get(SourceBlob, ident) is None for ident in chunks - pending_pages)
    drain(pending, adapter)
    from alerts.history_artifacts import read_artifact

    with database.begin() as db:
        assert read_artifact(db, pending, "D1")[0]["close"] == "11"


def test_saved_native_indicator_chart_protects_fixed_version_after_cache_cleanup(database):
    from alerts import fixed_indicators

    dataset = prepare(database)
    version = run(database, dataset, "2024-01-05", Adapter({"D1": [day("2024-01-02"), day("2024-01-03")]}))
    query = DataQuery(instrument=version, series_kind="history", timeframe="D1", limit=10,
        indicators=[{"id": "sma", "name": "SMA", "params": {"period": 2}}])
    first = data_sync(query)
    job = first["indicator_progress"][0]["run_id"]
    while fixed_indicators.indicator_tick(job):
        pass
    expected = data_sync(query)["indicators"]
    with database.begin() as db:
        plan = db.get(DatasetMaintenance, dataset)
        plan.paused = plan.archived = True
        db.add(ChartWorkspace(name="native-fixed-indicator", document={"version_id": version}))
        content = db.scalars(select(HistoryChunk.content_id).where(HistoryChunk.version_id == version)).all()
        db.execute(delete(SourceFetch).where(SourceFetch.content_id.in_(content)))
    with database.begin() as db:
        with pytest.raises(ValueError, match="引用"):
            reclaim(db, dataset, "protected-native")
    assert data_sync(query)["indicators"] == expected
