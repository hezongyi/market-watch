import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text


def test_managed_migration_roundtrip_preserves_legacy_history_start_and_state():
    path=Path(__file__).resolve().parents[2]/'migrations/versions/l13_managed_publication.py'
    spec=importlib.util.spec_from_file_location('managed_migration',path)
    migration=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    engine=create_engine('sqlite://')
    with engine.begin() as conn:
        conn.execute(text('CREATE TABLE instruments (id varchar(40) PRIMARY KEY)'))
        conn.execute(text('CREATE TABLE chart_history_plans (instrument_id varchar(40) PRIMARY KEY, target_start bigint, target_end bigint, status varchar(20), updated_at bigint)'))
        conn.execute(text("INSERT INTO chart_history_plans VALUES ('BTCUSDT', 1000, 2000, 'cancelled', 3000)"))
        migration.op=Operations(MigrationContext.configure(conn))
        for _ in range(2):
            migration.upgrade()
            row=conn.execute(text('SELECT * FROM chart_history_plans')).mappings().one()
            assert (row['target_start'],row['target_end'],row['cursor'],row['status'])==(1000,2000,2000,'cancelled')
            assert row['realtime_enabled'] and row['realtime_end']==0
            assert inspect(conn).has_table('chart_published_bars')
            migration.downgrade()
            assert not inspect(conn).has_table('chart_publications')
            assert not inspect(conn).has_table('chart_published_bars')
            assert conn.execute(text('SELECT target_start,target_end,status FROM chart_history_plans')).one()==(1000,2000,'cancelled')
    engine.dispose()
