"""Incremental fixed histories reference immutable period payloads."""

import json
from datetime import UTC, datetime

import pytest
from alerts.history_artifacts import artifact_tick, read_artifact
from alerts.history_maintenance import configure, create_run
from alerts.history_versions import import_page
from alerts.storage import HistoryArtifact, HistoryArtifactBlock, HistoryVersion
from sqlalchemy import select
from test_history_artifacts import finish
from test_history_maintenance import Adapter
from test_market_contracts import identity
from test_market_datasets import register


def test_unchanged_period_payload_is_shared_without_recompression(database, monkeypatch):
    import alerts.history_artifacts as artifacts

    end = 6001 * 60000
    with database.begin() as db:
        register(db)
        configure(db, identity().key, target_start=0, timeframes=["M1"], overlap_minutes=1)
        parent = create_run(db, identity().key, end=end, request_id="initial").id
    import_page(Adapter(), version_id=parent)
    finish(parent)
    with database.begin() as db:
        parent_manifest = json.dumps(db.get(HistoryVersion, parent).manifest, sort_keys=True)
        child = create_run(db, identity().key, end=end + 60000, request_id="next").id
    adapter = Adapter(close="1.10")
    while import_page(adapter, version_id=child):
        pass
    calls = []
    compress = artifacts.gzip.compress

    def tracked(*args, **kwargs):
        calls.append(len(args[0]))
        return compress(*args, **kwargs)

    monkeypatch.setattr(artifacts.gzip, "compress", tracked)
    assert artifact_tick(child)
    assert not calls, "unchanged published period payload must not be recompressed"
    with database.begin() as db:
        block = db.scalar(
            select(HistoryArtifactBlock)
            .join(HistoryArtifact)
            .where(HistoryArtifact.version_id == child)
        )
        assert block.content == b"" and block.source_block_id
    finish(child)
    with database.begin() as db:
        rows = read_artifact(db, child, "M1", limit=10000)
        assert len(rows) == 6002 and all(r["parent_version_id"] == child for r in rows)
        assert [r["close"] for r in rows[-3:]] == ["1.11", "1.10", "1.10"]
        assert (
            json.dumps(db.get(HistoryVersion, parent).manifest, sort_keys=True) == parent_manifest
        )


def prepared_pair(database, *, end=6001 * 60000):
    with database.begin() as db:
        register(db)
        configure(db, identity().key, target_start=0, timeframes=["M1"], overlap_minutes=1)
        parent = create_run(db, identity().key, end=end, request_id="parent").id
    import_page(Adapter(), version_id=parent)
    finish(parent)
    with database.begin() as db:
        child = create_run(db, identity().key, end=end + 60000, request_id="child").id
    while import_page(Adapter(close="1.10"), version_id=child):
        pass
    return parent, child


def test_multiple_generations_resolve_one_hop_and_pagination(database):
    from alerts.storage import DatasetMaintenance

    parent, child = prepared_pair(database)
    finish(child)
    with database.begin() as db:
        grandchild = create_run(db, identity().key, end=6003 * 60000, request_id="grandchild").id
    while import_page(Adapter(close="1.09"), version_id=grandchild):
        pass
    finish(grandchild)
    with database.begin() as db:
        refs = list(
            db.scalars(
                select(HistoryArtifactBlock)
                .join(HistoryArtifact)
                .where(
                    HistoryArtifact.version_id == grandchild,
                    HistoryArtifactBlock.source_block_id.is_not(None),
                )
            )
        )
        assert refs and all(
            not db.get(HistoryArtifactBlock, b.source_block_id).source_block_id for b in refs
        )
        first = read_artifact(db, grandchild, "M1", end=5000 * 60000, limit=5000)
        tail = read_artifact(
            db, grandchild, "M1", start=5000 * 60000, limit=5000, newest_first=True
        )
        assert len(first + tail) == 6003
        assert [r["close"] for r in tail[-4:]] == ["1.11", "1.10", "1.09", "1.09"]
        assert all(r["parent_version_id"] == grandchild for r in first + tail)
        assert db.get(DatasetMaintenance, identity().key).active_version_id is None
        assert len(read_artifact(db, parent, "M1", limit=10000)) == 6001


def test_legacy_inline_blocks_are_adopted_without_mutating_payload(database):
    from sqlalchemy import update

    parent, child = prepared_pair(database)
    with database.begin() as db:
        parent_ids = select(HistoryArtifact.id).where(HistoryArtifact.version_id == parent)
        db.execute(
            update(HistoryArtifactBlock)
            .where(HistoryArtifactBlock.artifact_id.in_(parent_ids))
            .values(input_count=None, complete_count=None)
        )
        old = [
            (b.id, b.content, b.checksum)
            for b in db.scalars(
                select(HistoryArtifactBlock).where(HistoryArtifactBlock.artifact_id.in_(parent_ids))
            )
        ]
    finish(child)
    with database.begin() as db:
        assert [
            (db.get(HistoryArtifactBlock, key).content, db.get(HistoryArtifactBlock, key).checksum)
            for key, _, _ in old
        ] == [(content, checksum) for _, content, checksum in old]
        rows = read_artifact(db, child, "M1", limit=10000)
        assert len(rows) == 6002 and rows[0]["parent_version_id"] == child
        ref = db.scalar(
            select(HistoryArtifactBlock)
            .join(HistoryArtifact)
            .where(
                HistoryArtifact.version_id == child,
                HistoryArtifactBlock.source_block_id.is_not(None),
            )
        )
        assert ref.input_count == ref.count and ref.complete_count is not None


def test_corrupt_original_payload_is_detected_through_shared_reference(database):
    import pytest
    from sqlalchemy import update

    _, child = prepared_pair(database)
    finish(child)
    with database.begin() as db:
        ref = db.scalar(
            select(HistoryArtifactBlock)
            .join(HistoryArtifact)
            .where(
                HistoryArtifact.version_id == child,
                HistoryArtifactBlock.source_block_id.is_not(None),
            )
        )
        import gzip

        db.execute(
            update(HistoryArtifactBlock)
            .where(HistoryArtifactBlock.id == ref.source_block_id)
            .values(content=gzip.compress(b"[]"))
        )
    with database.begin() as db:
        with pytest.raises(ValueError, match="checksum"):
            read_artifact(db, child, "M1", limit=10000)


def test_shared_payload_rejects_other_frame_or_reference_chain(database):
    import pytest

    parent, child = prepared_pair(database)
    finish(child)
    with database.begin() as db:
        ref = db.scalar(
            select(HistoryArtifactBlock)
            .join(HistoryArtifact)
            .where(
                HistoryArtifact.version_id == child,
                HistoryArtifactBlock.source_block_id.is_not(None),
            )
        )
        reference = dict(
            start=ref.start,
            end=ref.end,
            count=ref.count,
            checksum=ref.checksum,
            input_count=ref.input_count,
            complete_count=ref.complete_count,
            content=b"",
        )
        chained_id = ref.id
        original_id = ref.source_block_id
        aid = ref.artifact_id
    with pytest.raises(ValueError, match="reference"):
        with database.begin() as db:
            db.add(HistoryArtifactBlock(artifact_id=aid, source_block_id=chained_id, **reference))
    from alerts.history_artifacts import request_artifacts

    with database.begin() as db:
        request_artifacts(db, db.get(HistoryVersion, child), ["H1"])
        other = db.scalar(
            select(HistoryArtifact).where(
                HistoryArtifact.version_id == child, HistoryArtifact.timeframe == "H1"
            )
        )
        other_id = other.id
    with pytest.raises(ValueError, match="identity"):
        with database.begin() as db:
            db.add(
                HistoryArtifactBlock(artifact_id=other_id, source_block_id=original_id, **reference)
            )


def test_reclaim_removes_shared_and_inline_blocks_together(database):
    from alerts.history_retention import reclaim
    from alerts.storage import DatasetMaintenance
    from sqlalchemy import func

    _, child = prepared_pair(database)
    finish(child)
    with database.begin() as db:
        plan = db.get(DatasetMaintenance, identity().key)
        plan.archived = plan.paused = True
        result = reclaim(db, identity().key, "shared-clear")
        assert result["deleted"]["market_history_artifact_blocks"] > 1
        assert db.scalar(select(func.count()).select_from(HistoryArtifactBlock)) == 0


def test_disabling_new_sharing_preserves_existing_shared_reads(database, monkeypatch):
    from alerts.config import settings

    _, child = prepared_pair(database)
    finish(child)
    monkeypatch.setattr(settings, "history_block_sharing_enabled", False)
    with database.begin() as db:
        grandchild = create_run(db, identity().key, end=6003 * 60000, request_id="rollback-mode").id
    while import_page(Adapter(), version_id=grandchild):
        pass
    finish(grandchild)
    with database.begin() as db:
        assert len(read_artifact(db, child, "M1", limit=10000)) == 6002
        assert len(read_artifact(db, grandchild, "M1", limit=10000)) == 6003
        assert not db.scalar(
            select(HistoryArtifactBlock.id)
            .join(HistoryArtifact)
            .where(
                HistoryArtifact.version_id == grandchild,
                HistoryArtifactBlock.source_block_id.is_not(None),
            )
        )


def test_new_generation_reuses_metadata_without_decompressing_source(database, monkeypatch):
    import alerts.history_artifact_blocks as blocks

    _, child = prepared_pair(database)
    finish(child)
    with database.begin() as db:
        grandchild = create_run(db, identity().key, end=6003 * 60000, request_id="metadata-only").id
    while import_page(Adapter(), version_id=grandchild):
        pass
    calls = []
    original = blocks.gzip.decompress

    def tracked(content):
        calls.append(len(content))
        return original(content)

    monkeypatch.setattr(blocks.gzip, "decompress", tracked)
    assert artifact_tick(grandchild)
    assert calls == [], "known counters and single-hop references need no payload decode"


@pytest.mark.parametrize("date", ["2026-03-05", "2026-10-29"])
def test_shared_ny17_periods_match_full_recomputation_across_dst(database, monkeypatch, date):
    import alerts.history_artifacts as artifacts

    start = int(datetime.fromisoformat(date).replace(tzinfo=UTC).timestamp() * 1000)
    end = start + 12001 * 60000
    frames = ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN"]
    with database.begin() as db:
        register(db)
        configure(db, identity().key, target_start=start, timeframes=frames, overlap_minutes=2)
        parent = create_run(db, identity().key, end=end, request_id="dst-parent").id
    while import_page(Adapter(), version_id=parent):
        pass
    finish(parent)
    with database.begin() as db:
        child = create_run(db, identity().key, end=end + 60000, request_id="dst-shared").id
    while import_page(Adapter(close="1.10"), version_id=child):
        pass
    finish(child)
    with database.begin() as db:
        shared_frames = set(
            db.scalars(
                select(HistoryArtifact.timeframe)
                .join(HistoryArtifactBlock)
                .where(
                    HistoryArtifact.version_id == child,
                    HistoryArtifactBlock.source_block_id.is_not(None),
                )
            )
        )
        assert {"M1", "H4", "D1"} <= shared_frames
        expected = {frame: read_artifact(db, child, frame, limit=20000) for frame in frames}
        rebuilt = create_run(db, identity().key, end=end + 60000, request_id="dst-full-rebuild").id
    while import_page(Adapter(close="1.10"), version_id=rebuilt):
        pass
    # Same input snapshot and cutoff, with reuse completely bypassed.
    monkeypatch.setattr(artifacts, "_reuse_period_block", lambda *_: None)
    finish(rebuilt)

    def normalize(rows):
        return [{k: v for k, v in row.items() if k != "parent_version_id"} for row in rows]

    with database.begin() as db:
        for frame in frames:
            actual = read_artifact(db, rebuilt, frame, limit=20000)
            assert normalize(actual) == normalize(expected[frame]), frame


@pytest.mark.parametrize("mismatch", ["dataset", "price_rule"])
def test_references_cannot_cross_dataset_or_frozen_price_rule(database, mismatch):
    from alerts.history_versions import create_version

    parent, _ = prepared_pair(database)
    with database.begin() as db:
        original = db.scalar(
            select(HistoryArtifactBlock)
            .join(HistoryArtifact)
            .where(HistoryArtifact.version_id == parent)
        )
        source_id = original.id
        values = {
            key: getattr(original, key)
            for key in ("start", "end", "count", "checksum", "input_count", "complete_count")
        }
        source_artifact = db.get(HistoryArtifact, original.artifact_id)
        dataset_id = identity().key
        if mismatch == "dataset":
            register(db, identity(provider_symbol="GBPUSD"), logical_symbol="GBPUSD")
            dataset_id = identity(provider_symbol="GBPUSD").key
        vid = create_version(db, dataset_id, 0, 6002 * 60000)
        if mismatch == "price_rule":
            version = db.get(HistoryVersion, vid)
            version.manifest = {**version.manifest, "price_precision": 6}
        target = HistoryArtifact(
            id="target-" + mismatch,
            version_id=vid,
            timeframe="M1",
            rule_version=source_artifact.rule_version,
            status="pending",
            cursor=0,
            count=0,
            complete_count=0,
            accumulator={},
            manifest={},
        )
        db.add(target)
        db.flush()
        target_id = target.id
    with pytest.raises(ValueError, match="identity mismatch"):
        with database.begin() as db:
            db.add(
                HistoryArtifactBlock(
                    artifact_id=target_id, source_block_id=source_id, content=b"", **values
                )
            )


def test_sqlite_bootstrap_adds_sharing_without_rewriting_legacy_payload():
    from alerts.storage import _bootstrap_artifact_sharing
    from sqlalchemy import create_engine, inspect, text

    engine = create_engine("sqlite://")
    with engine.begin() as db:
        db.execute(
            text(
                "CREATE TABLE market_history_artifact_blocks (id VARCHAR(36) PRIMARY KEY, content BLOB NOT NULL)"
            )
        )
        db.execute(text("INSERT INTO market_history_artifact_blocks VALUES ('legacy', X'123456')"))
        _bootstrap_artifact_sharing(db)
        _bootstrap_artifact_sharing(db)
        assert {"source_block_id", "input_count", "complete_count"} <= {
            column["name"] for column in inspect(db).get_columns("market_history_artifact_blocks")
        }
        assert db.execute(
            text(
                "SELECT content,source_block_id,input_count,complete_count FROM market_history_artifact_blocks"
            )
        ).one() == (b"\x12\x34\x56", None, None, None)
    engine.dispose()


def test_sqlite_bootstrap_migration_roundtrip_preserves_legacy_payload():
    import importlib.util
    from pathlib import Path

    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    from alerts.storage import _bootstrap_artifact_sharing
    from sqlalchemy import create_engine, inspect, text

    path = Path(__file__).resolve().parents[2] / "migrations/versions/bf59_history_block_sharing.py"
    spec = importlib.util.spec_from_file_location("sharing_sqlite_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    engine = create_engine("sqlite://")
    with engine.begin() as db:
        db.execute(
            text(
                "CREATE TABLE market_history_artifact_blocks (id VARCHAR(36) PRIMARY KEY, content BLOB NOT NULL)"
            )
        )
        db.execute(text("INSERT INTO market_history_artifact_blocks VALUES ('legacy', X'123456')"))
        _bootstrap_artifact_sharing(db)
        with Operations.context(MigrationContext.configure(db)):
            migration.upgrade()
            migration.downgrade()
        assert {c["name"] for c in inspect(db).get_columns("market_history_artifact_blocks")} == {
            "id",
            "content",
        }
        assert (
            db.scalar(text("SELECT content FROM market_history_artifact_blocks")) == b"\x12\x34\x56"
        )
        with Operations.context(MigrationContext.configure(db)):
            migration.upgrade()
        assert db.execute(text("PRAGMA foreign_key_check")).all() == []
        assert (
            db.scalar(text("SELECT content FROM market_history_artifact_blocks")) == b"\x12\x34\x56"
        )
    engine.dispose()
