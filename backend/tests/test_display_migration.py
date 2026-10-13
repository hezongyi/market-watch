"""Additive migration parity and refusal to destroy accepted observations."""
import importlib.util
from pathlib import Path
import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text


def check(engine):
    paths = ['at47_display_observations', 'au48_display_indicator_tasks']
    migrations = []
    for name in paths:
        spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().parents[2] / ('migrations/versions/' + name + '.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        migrations.append(module)
    with engine.begin() as conn:
        for name in ('market_datasets', 'market_composite_revisions', 'market_fixed_indicator_runs'):
            conn.execute(text(f'CREATE TABLE {name} (id VARCHAR(64) PRIMARY KEY)'))
        for module in migrations:
            module.op = Operations(MigrationContext.configure(conn))
            module.upgrade()
            module.upgrade()
        assert inspect(conn).has_table('market_observed_minutes')
        assert inspect(conn).has_table('market_display_indicator_tasks')
        for module in reversed(migrations):
            module.downgrade()
        for module in migrations:
            module.upgrade()
        conn.execute(text("INSERT INTO market_datasets (id) VALUES ('test')"))
        conn.execute(text("INSERT INTO market_observed_minutes (dataset_id,start,epoch,content,observed_at,sequence) VALUES ('test',0,1,'{}',1,1)"))
        with pytest.raises(RuntimeError, match='backup'):
            migrations[0].downgrade()
        assert conn.scalar(text('SELECT count(*) FROM market_observed_minutes')) == 1


def test_display_migrations_preserve_observations():
    engine = create_engine('sqlite://')
    try:
        check(engine)
    finally:
        engine.dispose()
