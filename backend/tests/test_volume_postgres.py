"""Actual PostgreSQL quantity precision and NULL-safe revisions."""
import importlib.util
import os
from decimal import Decimal as D
from pathlib import Path

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alerts.bar_batch import write_bars
from alerts.domain import Candle
from alerts.storage import Bar, instant
from sqlalchemy import select, text
from test_managed_revisions_postgres import managed_pg as pg_fixture
from test_volume import (
    test_old_published_volume_revision_ignores_new_live_coverage_edges as check_old_publication,
)
from test_volume import (
    test_volume_only_ingest_preserves_price_and_duplicate_is_noop as check_isolation,
)

managed_pg = pg_fixture

pytestmark = pytest.mark.skipif(not os.getenv('TEST_POSTGRES_URL'), reason='Requires isolated PostgreSQL')


def test_pg_quantity_exact_null_safe_and_legacy_replay(managed_pg):
    factory, _ = managed_pg
    amount = D('99999999999999999999.123456789123456789')
    candle = Candle(instant(0), instant(60000), D(10), D(11), D(9), D(10))
    from dataclasses import replace
    with factory.begin() as db:
        write_bars(db, 'BTCUSDT', 'M1', [candle], observed_at=1)
    with factory.begin() as db:
        changes = write_bars(db, 'BTCUSDT', 'M1', [replace(candle, volume=amount)], observed_at=2)
        assert changes.volume == {0} and not changes.price
    with factory.begin() as db:
        bar = db.scalar(select(Bar))
        assert bar.volume == amount and bar.revision == 1 and bar.volume_revision == 1
        write_bars(db, 'BTCUSDT', 'M1', [candle], observed_at=3)
        assert bar.volume == amount and bar.volume_revision == 1
        changes = write_bars(db, 'BTCUSDT', 'M1', [replace(candle, volume=D(0))], observed_at=4)
        assert changes.volume == {0} and bar.volume == 0 and bar.revision == 1
        write_bars(db, 'BTCUSDT', 'M1', [replace(candle, volume=amount)], observed_at=2)
        assert bar.volume == 0 and bar.volume_revision == 2
        write_bars(db, 'BTCUSDT', 'M1', [replace(candle, high=D(12))], observed_at=5)
        assert bar.volume is None and not bar.volume_complete and bar.revision == 2


def test_pg_volume_only_price_isolation(managed_pg):
    check_isolation(managed_pg[0])


def test_pg_old_published_volume_revision_outside_live_coverage(managed_pg):
    check_old_publication(managed_pg[0])


def test_pg_volume_migration_roundtrip_keeps_legacy_prices(managed_pg):
    factory, engine = managed_pg
    with factory.begin() as db:
        write_bars(db, 'BTCUSDT', 'M1', [Candle(instant(0), instant(60000), D(10), D(11), D(9), D(10))])
    path = Path(__file__).resolve().parents[2]/'migrations/versions/p17_volume.py'
    spec = importlib.util.spec_from_file_location('volume_migration', path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    with engine.begin() as conn:
        migration.op = Operations(MigrationContext.configure(conn))
        prices = conn.execute(text('SELECT open, high, low, close, complete, revision FROM candles')).all()
        for _ in range(2):
            migration.downgrade()
            migration.upgrade()
            assert conn.execute(text('SELECT open, high, low, close, complete, revision FROM candles')).all() == prices
            assert conn.execute(text('SELECT volume, volume_complete, volume_revision FROM candles')).one() == (None, False, 0)
