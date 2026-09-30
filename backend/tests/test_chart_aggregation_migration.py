"""The undeployed queue migration must support upgrade and rollback."""
import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text


def test_aggregation_migration_roundtrip():
    path = Path(__file__).resolve().parents[2] / 'migrations/versions/k12_chart_aggregation.py'
    spec = importlib.util.spec_from_file_location('aggregation_migration', path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    engine = create_engine('sqlite://')
    with engine.begin() as connection:
        connection.execute(text('CREATE TABLE instruments (id varchar(40) PRIMARY KEY)'))
        migration.op = Operations(MigrationContext.configure(connection))
        for _ in range(2):
            migration.upgrade()
            inspector = inspect(connection)
            assert {column['name'] for column in inspector.get_columns('chart_aggregation_jobs')} == {
                'id', 'instrument_id', 'timeframe', 'start', 'end', 'created_at',
                'attempts', 'next_at', 'error'}
            assert len(inspector.get_unique_constraints('chart_aggregation_jobs')) == 1
            assert len(inspector.get_foreign_keys('chart_aggregation_jobs')) == 1
            migration.downgrade()
            assert not inspect(connection).has_table('chart_aggregation_jobs')
    engine.dispose()
