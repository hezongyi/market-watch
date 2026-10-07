import importlib.util
import os
from pathlib import Path

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alerts.market import ingest
from alerts.storage import Bar, MarketDataset
from postgres_migration_helpers import complete, predecessor
from sqlalchemy import inspect, select
from test_market_contracts import batch
from test_market_datasets import register
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg

pytestmark = pytest.mark.skipif(
    not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated Ubuntu Docker PostgreSQL"
)


def test_postgres_dataset_registration_ingestion_and_rollback_guard(provider_pg, monkeypatch):
    factory, engine = provider_pg
    path = Path(__file__).resolve().parents[2] / "migrations/versions/s20_market_datasets.py"
    spec = importlib.util.spec_from_file_location("dataset_pg_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    config = predecessor(engine, monkeypatch, migration.down_revision)
    with engine.begin() as conn:
        migration.op = Operations(MigrationContext.configure(conn))
        migration.upgrade()
        migration.downgrade()
        migration.upgrade()
        assert inspect(conn).has_table("market_datasets")
    complete(config, migration.revision)
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
