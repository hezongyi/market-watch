"""Source migration and concurrent linking in an isolated PostgreSQL schema."""

import os
from concurrent.futures import ThreadPoolExecutor

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alerts.history_versions import create_version, import_page, snapshot_rows
from alerts.storage import (
    DatasetSource,
    HistoryVersion,
    MarketDataset,
    SourceBlob,
    SourceFetch,
    SourceSeries,
)
from sqlalchemy import func, select, text
from test_history_versions import Adapter
from test_market_contracts import batch, identity
from test_market_datasets import register
from test_provider_postgres import provider_pg as _provider_pg
from test_source_registry import migration

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"),
                               reason="Requires isolated Ubuntu PostgreSQL")


def test_source_migration_preserves_old_bars_versions_and_unmapped_legacy(provider_pg):
    factory, engine = provider_pg
    with factory.begin() as db:
        register(db)
        register(db, identity(calendar_version="utc0-v1"))
        register(db, identity(channel="node"))
        version_id = create_version(db, identity().key, 0, 120000)
    import_page(Adapter([batch(checkpoint=120000)]), version_id=version_id)
    with factory.begin() as db:
        old_rows = list(snapshot_rows(db, version_id))
        manifest = db.get(HistoryVersion, version_id).manifest
        old_datasets = list(db.execute(select(MarketDataset.id, MarketDataset.identity).order_by(MarketDataset.id)))
    with engine.begin() as conn:
        # Reproduce pre-z27 inline snapshots before testing y26 independently.
        conn.execute(text("UPDATE market_history_chunks SET content = "
            "(SELECT content FROM market_source_blobs WHERE id = content_id), content_id = NULL"))
        conn.execute(text("DROP TABLE market_source_fetches"))
        conn.execute(text("DROP TABLE market_source_blobs"))
        conn.execute(text("DROP TABLE market_dataset_sources"))
        conn.execute(text("DROP TABLE market_source_series"))
        m = migration()
        m.op = Operations(MigrationContext.configure(conn))
        m.upgrade()
        m.upgrade()
        SourceBlob.__table__.create(conn)
        SourceFetch.__table__.create(conn)
        with conn.begin_nested():
            with pytest.raises(RuntimeError, match="backup"):
                m.downgrade()
    with factory.begin() as db:
        assert list(snapshot_rows(db, version_id)) == old_rows
        assert db.get(HistoryVersion, version_id).manifest == manifest
        assert list(db.execute(select(MarketDataset.id, MarketDataset.identity).order_by(MarketDataset.id))) == old_datasets
        assert db.scalar(select(func.count()).select_from(SourceSeries)) == 1
        assert db.scalar(select(func.count()).select_from(DatasetSource)) == 2
        assert db.get(DatasetSource, identity(channel="node").key) is None


def test_concurrent_existing_registration_links_exactly_one_collection(provider_pg):
    factory, engine = provider_pg
    with factory.begin() as db:
        register(db)
    with engine.begin() as conn:
        # Simulate the additive migration's predecessor, retaining the dataset.
        conn.execute(text("DELETE FROM market_dataset_sources"))
        conn.execute(text("DELETE FROM market_source_series"))

    def link():
        with factory.begin() as db:
            return register(db).id

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: link(), range(8)))
    assert len(set(results)) == 1
    with factory.begin() as db:
        assert db.scalar(select(func.count()).select_from(SourceSeries)) == 1
        assert db.scalar(select(func.count()).select_from(DatasetSource)) == 1
