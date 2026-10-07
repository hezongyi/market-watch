import importlib.util
from pathlib import Path

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text


def test_history_snapshot_migration_roundtrip_preserves_dataset_mapping():
    path = Path(__file__).resolve().parents[2] / "migrations/versions/t21_history_snapshots.py"
    spec = importlib.util.spec_from_file_location("history_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE market_datasets (id varchar(64) PRIMARY KEY)"))
        connection.execute(text("INSERT INTO market_datasets VALUES ('original')"))
        migration.op = Operations(MigrationContext.configure(connection))
        for _ in range(2):
            migration.upgrade()
            assert inspect(connection).has_table("market_history_chunks")
            connection.execute(text("INSERT INTO market_history_versions "
                "(id,dataset_id,start,end,cursor,status,created_at,manifest,lease_until,attempts,next_at) "
                "VALUES ('v1','original',0,60000,0,'pending',0,'{}',0,0,0)"))
            with pytest.raises(RuntimeError, match="backup"):
                migration.downgrade()
            connection.execute(text("DELETE FROM market_history_versions WHERE id='v1'"))
            migration.downgrade()
            assert not inspect(connection).has_table("market_history_versions")
            assert connection.execute(text("SELECT id FROM market_datasets")).scalar() == "original"
    engine.dispose()
