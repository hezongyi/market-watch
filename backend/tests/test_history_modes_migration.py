"""Exercise an actual pre-modes schema, not create_all pretending to migrate."""

import gzip
import hashlib
import importlib.util
from pathlib import Path

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alerts.storage import Base, bootstrap
from sqlalchemy import create_engine, inspect, text


def upgrade(connection):
    path = Path(__file__).resolve().parents[2] / "migrations/versions/ay52_history_modes.py"
    spec = importlib.util.spec_from_file_location("history_modes_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    with Operations.context(MigrationContext.configure(connection)):
        migration.upgrade()
    return migration


def old_schema(connection):
    # These are the old schema columns, not imports of current ORM definitions.
    for ddl in (
        "CREATE TABLE market_datasets (id VARCHAR(64) PRIMARY KEY, identity JSON NOT NULL)",
        "CREATE TABLE market_source_series (id VARCHAR(64) PRIMARY KEY, identity JSON NOT NULL)",
        "CREATE TABLE market_history_versions (id VARCHAR(36) PRIMARY KEY, dataset_id VARCHAR(64), manifest JSON)",
        "CREATE TABLE market_history_chunks (id VARCHAR(36) PRIMARY KEY, version_id VARCHAR(36), start BIGINT, end BIGINT, checksum VARCHAR(64), content BLOB, UNIQUE(version_id,start))",
        "CREATE TABLE market_history_read_attempts (id VARCHAR(36) PRIMARY KEY, version_id VARCHAR(36), result VARCHAR(40))",
        "CREATE TABLE market_dataset_maintenance (dataset_id VARCHAR(64) PRIMARY KEY, timeframes JSON)",
    ):
        connection.execute(text(ddl))


def test_real_sqlite_upgrade_preserves_existing_m1_ids_bytes_and_defaults():
    engine = create_engine("sqlite://")
    content = gzip.compress(b'[{"timestamp":0,"close":"1.1"}]', mtime=0)
    checksum = hashlib.sha256(content).hexdigest()
    with engine.begin() as connection:
        old_schema(connection)
        connection.execute(text("INSERT INTO market_datasets VALUES ('old-key', '{\"source\":\"dukascopy\"}')"))
        connection.execute(text("INSERT INTO market_history_versions VALUES ('old-version', 'old-key', '{\"checksum\":\"unchanged\"}')"))
        connection.execute(text("INSERT INTO market_history_chunks VALUES ('old-chunk','old-version',0,60000,:digest,:data)"), {"digest": checksum, "data": content})
        connection.execute(text("INSERT INTO market_history_read_attempts VALUES ('old-attempt','old-version','data')"))
        connection.execute(text("INSERT INTO market_dataset_maintenance VALUES ('old-key','[\"M1\",\"D1\"]')"))
        before = connection.execute(text("SELECT * FROM market_history_chunks")).first()
        migration = upgrade(connection)
        after = connection.execute(text("SELECT id,version_id,start,end,checksum,content FROM market_history_chunks")).first()
        assert before == after
        assert connection.scalar(text("SELECT timeframe FROM market_history_chunks")) == "M1"
        assert connection.scalar(text("SELECT timeframe FROM market_history_read_attempts")) == "M1"
        assert connection.scalar(text("SELECT frame_plan FROM market_dataset_maintenance")) == "{}"
        assert connection.scalar(text("SELECT manifest FROM market_history_versions")) == '{"checksum":"unchanged"}'
        assert connection.scalar(text("SELECT COUNT(*) FROM market_history_frame_runs")) == 0
        assert connection.scalar(text("SELECT COUNT(*) FROM market_dataset_frame_sources")) == 0
        connection.execute(text("INSERT INTO market_history_chunks (id,version_id,start,end,checksum,content,timeframe) VALUES ('daily','old-version',0,86400000,:digest,:data,'D1')"), {"digest": checksum, "data": content})
        upgrade(connection)  # bootstrap-created/new databases are safe too
        with pytest.raises(RuntimeError, match="Retain archived"):
            migration.downgrade()
    engine.dispose()


def test_sqlite_bootstrap_upgrades_old_columns_and_constraint_without_rewriting():
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        Base.metadata.create_all(connection)
        with Operations.context(MigrationContext.configure(connection)) as operations:
            with operations.batch_alter_table("market_history_chunks") as batch:
                batch.drop_constraint("uq_history_chunk_version_frame_start", type_="unique")
                batch.drop_column("timeframe")
                batch.create_unique_constraint("old_chunk_unique", ["version_id", "start"])
            with operations.batch_alter_table("market_history_read_attempts") as batch:
                batch.drop_column("timeframe")
            with operations.batch_alter_table("market_dataset_maintenance") as batch:
                batch.drop_column("frame_plan")
    bootstrap(engine)
    bootstrap(engine)
    assert {c["name"] for c in inspect(engine).get_columns("market_history_chunks")} >= {"timeframe"}
    assert any(c["column_names"] == ["version_id", "timeframe", "start"]
               for c in inspect(engine).get_unique_constraints("market_history_chunks"))
    engine.dispose()
