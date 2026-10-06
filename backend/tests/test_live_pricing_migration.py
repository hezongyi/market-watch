import importlib.util
from pathlib import Path

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text


def test_live_migration_reversible_when_empty_and_preserves_collected_evidence():
    path = Path(__file__).resolve().parents[2] / "migrations/versions/v23_live_pricing.py"
    spec = importlib.util.spec_from_file_location("live_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    engine = create_engine("sqlite://")
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE market_datasets (id VARCHAR(64) PRIMARY KEY)"))
        migration.op = Operations(MigrationContext.configure(conn))
        migration.upgrade()
        assert {"quote_count", "age_histogram", "confirmed_at"} <= {
            column["name"] for column in inspect(conn).get_columns("market_live_minutes")}
        migration.downgrade()
        migration.upgrade()
        conn.execute(text("INSERT INTO market_pricing_owners "
            "(id,expires,epoch,connected_at,next_at,failures) VALUES ('account',0,1,0,0,0)"))
        with pytest.raises(RuntimeError, match="backup"):
            migration.downgrade()
        assert inspect(conn).has_table("market_pricing_owners")
    engine.dispose()
