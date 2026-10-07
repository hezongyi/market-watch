"""Upgrade from the actual v1.14.0 predecessor, preserve readers and raw proof."""

import os
import uuid
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from alerts.config import settings
from sqlalchemy import create_engine, inspect, text

pytestmark = pytest.mark.skipif(not os.getenv('TEST_POSTGRES_URL'), reason='Requires isolated Ubuntu PostgreSQL')
ROOT = Path(__file__).resolve().parents[2]


def test_actual_predecessor_upgrade_pending_downgrade_guard_and_schema_roundtrip(monkeypatch):
    schema = 'publication_upgrade_' + uuid.uuid4().hex
    admin = create_engine(os.environ['TEST_POSTGRES_URL'], pool_size=1, max_overflow=0)
    with admin.begin() as conn:
        conn.execute(text(f'CREATE SCHEMA {schema}'))
    url = admin.url.set(query={'options': f'-csearch_path={schema}'})
    engine = create_engine(url, pool_size=1, max_overflow=0)
    monkeypatch.setattr(settings, 'database_url', url.render_as_string(hide_password=False))
    config = Config(str(ROOT / 'alembic.ini'))
    config.set_main_option('script_location', str(ROOT / 'migrations'))
    try:
        command.upgrade(config, 'am40_chart_revision_demand')
        with engine.begin() as conn:
            assert 'chart_publication_state' not in inspect(conn).get_table_names()
            conn.execute(text("INSERT INTO instruments (id,label,source,symbol,basis,calendar,precision,quality,enabled) "
                "VALUES ('kept','kept','binance','BTCUSDT','last','utc0',2,'waiting',false)"))
            conn.execute(text("INSERT INTO chart_publications "
                '(instrument_id,timeframe,start,"end",complete_count,revision,initialized,updated_at) '
                "VALUES ('kept','M1',0,60000,1,7,true,8)"))
            conn.execute(text("INSERT INTO chart_published_bars "
                '(instrument_id,timeframe,start,"end",complete,payload,revision) '
                "VALUES ('kept','M1',0,60000,true,'{\"close\":\"10\"}',3)"))
            conn.execute(text("INSERT INTO market_data_coverage "
                '(id,instrument_id,source,basis,start,"end",observed,queried_at) '
                "VALUES ('proof','kept','binance','last',0,60000,1,65000)"))
            before = conn.execute(text('SELECT * FROM chart_published_bars')).all()
        command.upgrade(config, 'head')
        command.upgrade(config, 'head')
        with engine.connect() as conn:
            assert conn.execute(text('SELECT * FROM chart_published_bars')).all() == before
            assert conn.scalar(text('SELECT count(*) FROM chart_publication_state WHERE requested>processed')) == 9
            assert {'market_coverage_checkpoints', 'market_coverage_projection', 'market_coverage_quarantine'} <= set(inspect(conn).get_table_names())
        with pytest.raises(RuntimeError, match='Pending publication requests'):
            command.downgrade(config, 'am40_chart_revision_demand')
        # Alembic's PG transactional DDL rolls back the preceding projection
        # downgrade when the pending-state guard refuses this unsafe rollback.
        with engine.begin() as conn:
            assert 'market_coverage_projection' in inspect(conn).get_table_names()
            assert conn.scalar(text('SELECT version_num FROM alembic_version')) == 'ap43_publication_service_order'
            conn.execute(text('UPDATE chart_publication_state SET processed=requested'))
        command.downgrade(config, 'am40_chart_revision_demand')
        with engine.connect() as conn:
            assert conn.execute(text('SELECT * FROM chart_published_bars')).all() == before
            assert conn.scalar(text('SELECT count(*) FROM market_data_coverage')) == 1
        command.upgrade(config, 'head')
        with engine.connect() as conn:
            assert conn.execute(text('SELECT * FROM chart_published_bars')).all() == before
            assert conn.scalar(text('SELECT count(*) FROM chart_publication_state')) == 9
    finally:
        engine.dispose()
        with admin.begin() as conn:
            conn.execute(text(f'DROP SCHEMA {schema} CASCADE'))
        admin.dispose()
