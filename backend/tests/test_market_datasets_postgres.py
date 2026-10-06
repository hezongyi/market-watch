import importlib.util
import os
from pathlib import Path

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alerts.market import ingest
from alerts.storage import Bar, MarketDataset
from sqlalchemy import inspect, select, text
from test_market_contracts import batch
from test_market_datasets import register
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg

pytestmark = pytest.mark.skipif(
    not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated Ubuntu Docker PostgreSQL"
)


def test_postgres_dataset_registration_ingestion_and_rollback_guard(provider_pg):
    factory, engine = provider_pg
    path = Path(__file__).resolve().parents[2] / "migrations/versions/s20_market_datasets.py"
    spec = importlib.util.spec_from_file_location("dataset_pg_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    with engine.begin() as conn:
        # Reproduce the actual r19 predecessor schema, rather than dropping a
        # parent table while later migrations' foreign keys still reference it.
        for table in ("market_live_minutes", "market_live_states", "market_history_chunks",
                      "market_history_versions", "market_source_fetches", "market_source_blobs",
                      "market_dataset_sources", "market_source_series"):
            conn.execute(text(f"DROP TABLE {table}"))
        migration.op = Operations(MigrationContext.configure(conn))
        migration.downgrade()
        migration.upgrade()
        # s20 deliberately creates its historical schema. Upgrade the asset
        # metadata before exercising today's runtime registration contract.
        asset_path = path.with_name("x25_dataset_asset_class.py")
        asset_spec = importlib.util.spec_from_file_location("asset_pg_migration", asset_path)
        asset_migration = importlib.util.module_from_spec(asset_spec)
        asset_spec.loader.exec_module(asset_migration)
        asset_migration.op = Operations(MigrationContext.configure(conn))
        asset_migration.upgrade()
        from alerts.storage import DatasetSource, SourceBlob, SourceFetch, SourceSeries

        for table in (SourceSeries, DatasetSource, SourceBlob, SourceFetch):
            table.__table__.create(conn)
        assert inspect(conn).has_table("market_datasets")
    with factory.begin() as db:
        inst = register(db)
        ingest(db, inst, batch().ingestion_payload())
        assert len(db.scalars(select(Bar).where(Bar.timeframe == "M1")).all()) == 2
        assert db.scalar(select(MarketDataset)).instrument_id == inst.id
    with engine.begin() as conn:
        migration.op = Operations(MigrationContext.configure(conn))
        with pytest.raises(RuntimeError, match="backup"):
            migration.downgrade()
        assert inspect(conn).has_table("market_datasets")
