"""Shared source pages and old inline snapshots on real isolated PostgreSQL."""

import importlib.util
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
import test_source_history_store as contracts
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alerts import history_versions as history
from alerts.source_history_store import AcquisitionBusy, shared_page
from alerts.storage import HistoryChunk, SourceBlob
from sqlalchemy import func, select, text
from test_market_contracts import batch, identity
from test_market_datasets import register
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"),
                               reason="Requires isolated Ubuntu PostgreSQL")


@pytest.mark.parametrize("contract", [
    contracts.test_two_prepared_calendars_acquire_once_and_reference_one_original_blob,
    contracts.test_blob_cannot_be_mutated_or_deleted_and_reads_verify_content,
    contracts.test_replaced_source_lease_discards_page_and_leaves_version_retryable,
    contracts.test_volume_mismatch_does_not_poison_shared_storage,
], ids=lambda contract: contract.__name__)
def test_postgres_shared_source_contract(provider_pg, contract):
    factory, _ = provider_pg
    contract(factory)


def test_two_concurrent_acquisition_requests_share_fenced_page(provider_pg):
    factory, _ = provider_pg
    started, finish = threading.Event(), threading.Event()

    class Adapter:
        calls = 0

        def page(self, raw, start, end):
            self.calls += 1
            started.set()
            assert finish.wait(5)
            return batch(checkpoint=end)

    adapter = Adapter()
    with ThreadPoolExecutor(max_workers=2) as pool:
        owner = pool.submit(shared_page, adapter, identity(), 0, 120000, fresh_after=0)
        assert started.wait(3)
        try:
            with pytest.raises(AcquisitionBusy):
                shared_page(adapter, identity(), 0, 120000, fresh_after=0)
        finally:
            finish.set()
        assert len(owner.result(timeout=5).rows) == 2
    cached = shared_page(adapter, identity(calendar_version="utc0-v1"), 0, 120000, fresh_after=0)
    assert len(cached.rows) == 2 and cached.identity.calendar_version == "utc0-v1"
    assert adapter.calls == 1
    with factory.begin() as db:
        assert db.scalar(select(func.count()).select_from(SourceBlob)) == 1


def test_z27_additive_migration_keeps_inline_original_bytes_and_manifest(provider_pg):
    factory, engine = provider_pg
    with factory.begin() as db:
        register(db)
        ident = history.create_version(db, identity().key, 0, 120000)
    class Adapter:
        def page(self, raw, start, end):
            return batch(checkpoint=end)
    history.import_page(Adapter(), version_id=ident)
    with engine.begin() as conn:
        conn.execute(text("UPDATE market_history_chunks SET content = "
            "(SELECT content FROM market_source_blobs WHERE id = content_id), content_id = NULL"))
        old = conn.execute(text("SELECT content, checksum FROM market_history_chunks")).one()
        conn.execute(text("DROP TABLE market_source_fetches"))
        conn.execute(text("DROP TABLE market_source_blobs"))
        conn.execute(text("ALTER TABLE market_history_chunks DROP COLUMN content_id"))
        path = Path(__file__).resolve().parents[2] / "migrations/versions/z27_source_m1_store.py"
        spec = importlib.util.spec_from_file_location("source_store_migration", path)
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        m.op = Operations(MigrationContext.configure(conn))
        m.upgrade()
        m.upgrade()
        assert conn.execute(text("SELECT content, checksum FROM market_history_chunks")).one() == old
    with factory.begin() as db:
        assert len(list(history.snapshot_rows(db, ident))) == 2
        assert db.scalar(select(HistoryChunk)).content_id is None
