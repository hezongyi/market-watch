import importlib.util
from pathlib import Path

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text


def test_pinned_replay_migration_preserves_legacy_and_guards_used_versions():
    path = Path(__file__).resolve().parents[2] / "migrations/versions/u22_replay_dataset_version.py"
    spec = importlib.util.spec_from_file_location("replay_version_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    engine = create_engine("sqlite://")
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE replays (id varchar(36) PRIMARY KEY, bars JSON NOT NULL)"))
        conn.execute(text("INSERT INTO replays VALUES ('original', '[1,2,3]')"))
        migration.op = Operations(MigrationContext.configure(conn))
        for _ in range(2):
            migration.upgrade()
            assert conn.execute(text("SELECT bars,dataset_version,input_manifest FROM replays")).one() == ('[1,2,3]', None, '{}')
            conn.execute(text("UPDATE replays SET dataset_version='v1' WHERE id='original'"))
            with pytest.raises(RuntimeError, match="backup"):
                migration.downgrade()
            conn.execute(text("UPDATE replays SET dataset_version=NULL WHERE id='original'"))
            migration.downgrade()
            assert "dataset_version" not in {column["name"] for column in inspect(conn).get_columns("replays")}
            assert conn.execute(text("SELECT bars FROM replays")).scalar() == '[1,2,3]'
    engine.dispose()
