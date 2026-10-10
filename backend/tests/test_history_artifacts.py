"""Per-period publication never mutates its M1 parent or borrows staging bars."""

import json
from datetime import UTC, datetime

import pytest
from alerts.history_artifacts import (
    artifact_report,
    artifact_tick,
    chart_page,
    read_artifact,
    request_artifacts,
)
from alerts.history_versions import create_version, import_page
from alerts.storage import HistoryArtifact, HistoryArtifactBlock, HistoryVersion
from sqlalchemy import select
from test_history_versions import Adapter
from test_market_contracts import batch, minute
from test_market_datasets import register


def publish(database, *, start=0, end=120000, rows=None):
    with database.begin() as db:
        inst = register(db)
        from test_market_contracts import identity
        ident = create_version(db, identity().key, start, end)
    import_page(Adapter([batch(window_start=start, window_end=end, checkpoint=end,
        observed_at=end + 5000, rows=rows if rows is not None else (minute(start), minute(start + 60000)))]),
        version_id=ident)
    return ident, inst.id


def finish(ident):
    for _ in range(100):
        if not artifact_tick(ident):
            return
    raise AssertionError("Artifact build did not converge")


def test_m1_publication_does_not_claim_other_frames_ready(database):
    ident, _ = publish(database)
    with database.begin() as db:
        parent = json.dumps(db.get(HistoryVersion, ident).manifest, sort_keys=True)
        request_artifacts(db, db.get(HistoryVersion, ident), ["M1", "H4", "D1", "W1", "MN", "M30"])
        assert all(a["status"] == "pending" for a in artifact_report(db, ident))
        with pytest.raises(ValueError, match="尚未发布"):
            read_artifact(db, ident, "H4")
    finish(ident)
    with database.begin() as db:
        assert json.dumps(db.get(HistoryVersion, ident).manifest, sort_keys=True) == parent
        assert len(read_artifact(db, ident, "M1")) == 2
        for frame in ("H4", "D1", "W1", "MN", "M30"):
            rows = read_artifact(db, ident, frame)
            assert rows and all(not r["coverage_complete"] for r in rows)
            assert all(r["source_confirmed"] for r in rows)
            assert all(r["parent_version_id"] == ident for r in rows)
        before = artifact_report(db, ident)
        request_artifacts(db, db.get(HistoryVersion, ident), ["H4"])
        assert artifact_report(db, ident) == before


@pytest.mark.parametrize("date,hour", [("2026-01-06T23:00:00", 22), ("2026-07-06T23:00:00", 21)])
def test_artifact_h4_and_d1_follow_local_ny17_with_dst(database, date, hour):
    start = int(datetime.fromisoformat(date).replace(tzinfo=UTC).timestamp() * 1000)
    ident, _ = publish(database, start=start, end=start + 120000)
    with database.begin() as db:
        request_artifacts(db, db.get(HistoryVersion, ident), ["H4", "D1"])
    finish(ident)
    with database.begin() as db:
        for frame in ("H4", "D1"):
            row = read_artifact(db, ident, frame)[0]
            assert datetime.fromtimestamp(row["start"] / 1000, UTC).hour == hour


def test_large_bucket_build_resumes_without_holding_all_minutes(database):
    end = 6001 * 60000
    rows = tuple(minute(at) for at in range(0, end, 60000))
    ident, _ = publish(database, end=end, rows=rows)
    with database.begin() as db:
        request_artifacts(db, db.get(HistoryVersion, ident), ["MN"])
    # M1 first; each call advances one bounded page or one frame.
    assert artifact_tick(ident)
    with database.begin() as db:
        m1 = db.scalar(select(HistoryArtifact).where(HistoryArtifact.timeframe == "M1"))
        assert m1.status == "pending" and m1.cursor == 5000 * 60000
    finish(ident)
    with database.begin() as db:
        assert len(read_artifact(db, ident, "M1", limit=10000)) == 6001
        mn = read_artifact(db, ident, "MN")
        assert sum(r["observed_minutes"] for r in mn) == 6001
        assert all(not r["coverage_complete"] for r in mn)


def test_published_artifacts_and_blocks_are_immutable(database):
    ident, _ = publish(database)
    finish(ident)
    with pytest.raises(ValueError, match="immutable"):
        with database.begin() as db:
            db.scalar(select(HistoryArtifact)).manifest = {}
    with pytest.raises(ValueError, match="immutable"):
        with database.begin() as db:
            db.scalar(select(HistoryArtifactBlock)).content = b"changed"


def test_incremental_artifact_reuses_old_buckets_and_keeps_new_parent_reference(database):
    from alerts.history_maintenance import configure, create_run
    from test_history_maintenance import Adapter as MaintenanceAdapter
    from test_market_contracts import identity

    end = 6001 * 60000
    with database.begin() as db:
        register(db)
        configure(db, identity().key, target_start=0, timeframes=["M1"], overlap_minutes=1)
        parent = create_run(db, identity().key, end=end, request_id="initial").id
    import_page(MaintenanceAdapter(), version_id=parent)
    finish(parent)
    with database.begin() as db:
        old_manifest = json.dumps(db.get(HistoryVersion, parent).manifest, sort_keys=True)
        child = create_run(db, identity().key, end=end + 60000, request_id="next").id
    adapter = MaintenanceAdapter(close="1.10")
    while import_page(adapter, version_id=child):
        pass
    assert adapter.calls == [(end - 60000, end + 60000)]
    # One bounded tick advances through an existing 4,999-bar block instead
    # of rebuilding its observations; the remaining refresh builds normally.
    assert artifact_tick(child)
    with database.begin() as db:
        built = db.scalar(select(HistoryArtifact).where(HistoryArtifact.version_id == child))
        assert built.count == 4999 and built.accumulator == {}
    finish(child)
    with database.begin() as db:
        rows = read_artifact(db, child, "M1", limit=10000)
        assert len(rows) == 6002 and all(r["parent_version_id"] == child for r in rows)
        assert [r["close"] for r in rows[-3:]] == ["1.11", "1.10", "1.10"]
        assert json.dumps(db.get(HistoryVersion, parent).manifest, sort_keys=True) == old_manifest


def test_fixed_chart_pages_newest_first_without_overlap_or_price_filling(database):
    # Enough observations for multiple compressed blocks, plus unknown holes.
    end = 6005 * 60000
    observed = [at for at in range(0, end, 60000) if at not in (60000, 3000 * 60000)]
    ident, _ = publish(database, end=end, rows=tuple(minute(at) for at in observed))
    finish(ident)
    with database.begin() as db:
        pages, before = [], None
        while True:
            page = chart_page(db, ident, "M1", before=before, count=2000)
            assert all(row["parent_version_id"] == ident for row in page["bars"])
            assert [r["start"] for r in page["bars"]] == sorted(r["start"] for r in page["bars"])
            pages.insert(0, page["bars"])
            before = page["next_before"]
            if before is None:
                break
        assert [row["start"] for page in pages for row in page] == observed
        assert len(pages) == 4
        assert chart_page(db, ident, "M1", before=0)["bars"] == []
        with pytest.raises(ValueError, match="分页"):
            chart_page(db, ident, "M1", count=5001)


def test_chart_reads_only_newest_required_blocks_and_keeps_old_period_identity(database, monkeypatch):
    import alerts.history_artifacts as artifacts

    end = 6001 * 60000
    ident, _ = publish(database, end=end, rows=tuple(minute(at) for at in range(0, end, 60000)))
    finish(ident)
    decompress, touched = artifacts.gzip.decompress, []

    def tracked(content):
        touched.append(len(content))
        return decompress(content)

    monkeypatch.setattr(artifacts.gzip, "decompress", tracked)
    with database.begin() as db:
        page = chart_page(db, ident, "M1", count=2)
        assert [row["start"] for row in page["bars"]] == [5999 * 60000, 6000 * 60000]
        assert len(touched) == 1  # Does not decompress the older 4,999-bar block.
        request_artifacts(db, db.get(HistoryVersion, ident), ["H4"])
        with pytest.raises(ValueError, match="尚未发布"):
            chart_page(db, ident, "H4")


@pytest.mark.parametrize("parent_rule", ["legacy", "different_precision"])
def test_artifact_reuse_requires_compatible_version_price_rules(database, monkeypatch, parent_rule):
    from alerts import history_artifacts
    from alerts.history_maintenance import configure, create_run
    from test_market_contracts import identity
    from test_history_maintenance import Adapter as MaintenanceAdapter

    with database.begin() as db:
        register(db)
        configure(db, identity().key, target_start=0, timeframes=["M1"], overlap_minutes=1)
        parent = create_run(db, identity().key, end=180000, request_id="parent").id
        version = db.get(HistoryVersion, parent)
        version.manifest = ({"maintenance": version.manifest["maintenance"]} if parent_rule == "legacy"
                            else {**version.manifest, "price_precision": 6})
    close = "1.11111" if parent_rule == "legacy" else "1.111111"
    import_page(Adapter([batch(rows=(minute(0, close=close), minute(60000, close=close)),
                              checkpoint=120000, window_end=180000)]), version_id=parent)
    import_page(Adapter([batch(window_start=120000, window_end=180000, checkpoint=180000,
                              observed_at=185000, rows=(minute(120000, close=close),))]), version_id=parent)
    finish(parent)
    with database.begin() as db:
        child = create_run(db, identity().key, end=240000, request_id="child").id
    adapter = MaintenanceAdapter()
    while import_page(adapter, version_id=child):
        pass
    calls = []
    original = history_artifacts._add
    def track(state, row, instrument):
        calls.append(row["timestamp"])
        return original(state, row, instrument)
    monkeypatch.setattr(history_artifacts, "_add", track)
    finish(child)
    assert 0 in calls and 60000 in calls
    with database.begin() as db:
        from alerts.history_versions import snapshot_rows

        artifact = read_artifact(db, child, "M1")[0]
        assert artifact["close"] == list(snapshot_rows(db, child))[0]["close"] == "1.11111"
