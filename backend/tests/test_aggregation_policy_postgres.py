"""Real isolated PostgreSQL upgrade and immutable derivation checks."""

import importlib.util
import os
from pathlib import Path

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import inspect, text
from test_aggregation_policy import (
    test_changed_phase_reuses_original_m1_and_preserves_pinned_replay as verify_derived_phase,
)
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"),
                               reason="Requires isolated Ubuntu PostgreSQL")


def test_postgres_phase_derivation_preserves_original_versions(provider_pg):
    factory, _ = provider_pg
    verify_derived_phase(factory)


def test_postgres_asset_class_migration_preserves_old_phase(provider_pg):
    _, engine = provider_pg
    path = Path(__file__).resolve().parents[2] / "migrations/versions/x25_dataset_asset_class.py"
    spec = importlib.util.spec_from_file_location("asset_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    with engine.begin() as conn:
        conn.execute(text("ALTER TABLE market_datasets DROP COLUMN asset_class"))
        conn.execute(text("INSERT INTO instruments "
            "(id,label,source,symbol,basis,calendar,precision,quality,enabled) VALUES "
            "('MD:old','old','dukascopy','EUR/USD','bid','ny17',6,'waiting',false)"))
        conn.execute(text("INSERT INTO market_datasets "
            "(id,instrument_id,logical_symbol,identity,volume_kind) VALUES "
            "('old','MD:old','EURUSD','{}','quantity')"))
        migration.op = Operations(MigrationContext.configure(conn))
        migration.upgrade()
        migration.upgrade()
        assert conn.execute(text("SELECT asset_class FROM market_datasets WHERE id='old'")).scalar() == "unspecified"
        assert conn.execute(text("SELECT calendar FROM instruments WHERE id='MD:old'")).scalar() == "ny17"
        assert "asset_class" in {c["name"] for c in inspect(conn).get_columns("market_datasets")}
