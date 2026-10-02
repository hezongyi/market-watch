import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text


def test_revision_migration_seeds_reconciliation_and_preserves_snapshots_on_rollback():
    path = Path(__file__).resolve().parents[2] / "migrations/versions/o16_managed_revisions.py"
    spec = importlib.util.spec_from_file_location("managed_revision_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    engine = create_engine("sqlite://")
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE instruments (id varchar(40) PRIMARY KEY)"))
        conn.execute(text("INSERT INTO instruments VALUES ('BTCUSDT')"))
        conn.execute(text("CREATE TABLE chart_published_bars (instrument_id varchar(40), "
                          "timeframe varchar(8), start bigint, end bigint, complete boolean, "
                          "payload json, PRIMARY KEY (instrument_id, timeframe, start))"))
        conn.execute(text("INSERT INTO chart_published_bars VALUES "
                          "('BTCUSDT', 'M1', 60000, 120000, true, '{}')"))
        migration.op = Operations(MigrationContext.configure(conn))
        for _ in range(2):
            migration.upgrade()
            assert conn.execute(text("SELECT revision FROM chart_published_bars")).scalar() == 1
            assert conn.execute(text("SELECT start, end FROM chart_publication_jobs")).one() == (60000, 120000)
            migration.downgrade()
            assert not inspect(conn).has_table("chart_publication_jobs")
            assert conn.execute(text("SELECT start, end, payload FROM chart_published_bars")).one() == (60000, 120000, '{}')
    engine.dispose()
