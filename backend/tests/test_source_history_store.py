"""Shared immutable observations, fresh rechecks and fencing through public import."""

import pytest
from alerts import history_versions as history
from alerts.source_history_store import raw_chunk, shared_page
from alerts.storage import HistoryChunk, HistoryVersion, SourceBlob, SourceFetch
from sqlalchemy import func, select
from test_market_contracts import batch, identity
from test_market_datasets import register


def test_two_prepared_calendars_acquire_once_and_reference_one_original_blob(database):
    second_identity = identity(calendar_version="utc0-v1")
    with database.begin() as db:
        register(db)
        register(db, second_identity)
        versions = [history.create_version(db, raw.key, 0, 120000) for raw in (identity(), second_identity)]
        # Both requests existed before acquisition. Deterministic old creation
        # times avoid using clock granularity as evidence of sharing.
        for ident in versions:
            db.get(HistoryVersion, ident).created_at = 1

    class Adapter:
        calls = 0

        def page(self, raw, start, end):
            self.calls += 1
            return batch(identity=raw, checkpoint=end)

    adapter = Adapter()
    for ident in versions:
        assert history.import_page(adapter, version_id=ident)
    assert adapter.calls == 1
    with database.begin() as db:
        chunks = db.scalars(select(HistoryChunk)).all()
        assert len(chunks) == 2 and len({c.content_id for c in chunks}) == 1
        assert all(c.content == b"" for c in chunks)
        assert db.scalar(select(func.count()).select_from(SourceBlob)) == 1
        assert list(history.snapshot_rows(db, versions[0])) == list(history.snapshot_rows(db, versions[1]))
        assert db.get(HistoryVersion, versions[0]).manifest["identity"] != db.get(HistoryVersion, versions[1]).manifest["identity"]


def test_blob_cannot_be_mutated_or_deleted_and_reads_verify_content(database):
    with database.begin() as db:
        register(db)
        ident = history.create_version(db, identity().key, 0, 120000)
    class Adapter:
        def page(self, raw, start, end):
            return batch(checkpoint=end)
    history.import_page(Adapter(), version_id=ident)
    with pytest.raises(ValueError, match="immutable"):
        with database.begin() as db:
            db.scalar(select(SourceBlob)).content = b"invalid"
    with pytest.raises(ValueError, match="deleted"):
        with database.begin() as db:
            db.delete(db.scalar(select(SourceBlob)))
    with database.begin() as db:
        chunk = db.scalar(select(HistoryChunk))
        assert raw_chunk(db, chunk)
        # Invalid pointer cannot silently load an unrelated price sequence.
        from sqlalchemy import update
        db.execute(update(HistoryChunk).values(content_id="missing"))
    with pytest.raises(ValueError, match="reference"):
        with database.begin() as db:
            list(history.snapshot_rows(db, ident))


def test_replaced_source_lease_discards_page_and_leaves_version_retryable(database):
    with database.begin() as db:
        register(db)
        ident = history.create_version(db, identity().key, 0, 120000)

    class Replaced:
        def page(self, raw, start, end):
            with database.begin() as db:
                db.scalar(select(SourceFetch)).lease_token = "replacement"
            return batch(checkpoint=end)

    assert history.import_page(Replaced(), version_id=ident)
    with database.begin() as db:
        version = db.get(HistoryVersion, ident)
        assert version.status == "pending" and version.cursor == 0 and version.attempts == 0
        assert db.scalar(select(HistoryChunk)) is None and db.scalar(select(SourceBlob)) is None
        assert db.scalar(select(SourceFetch)).lease_token == "replacement"


def test_volume_mismatch_does_not_poison_shared_storage(database):
    class Adapter:
        def page(self, raw, start, end):
            return batch(checkpoint=end, volume_kind="base", volume_unit="EUR")
    with pytest.raises(ValueError, match="volume"):
        shared_page(Adapter(), identity(), 0, 120000, fresh_after=0)
    with database.begin() as db:
        assert db.scalar(select(SourceBlob)) is None
        assert db.scalar(select(SourceFetch)).lease_token is None
