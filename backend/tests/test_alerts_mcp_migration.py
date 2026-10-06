"""Both deployed branch schemas converge without losing existing records."""

from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from alerts.config import settings
from alerts.storage import HistoryVersion, Instrument
from sqlalchemy import create_engine, inspect, text

ROOT = Path(__file__).resolve().parents[2]
HEAD = "x25_dataset_asset_class"


def configuration():
    config = Config(str(ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(ROOT / "migrations"))
    return config


def verify_upgrade_paths(engine, monkeypatch, initial):
    monkeypatch.setattr(settings, "database_url", engine.url.render_as_string(hide_password=False))
    config = configuration()
    assert ScriptDirectory.from_config(config).get_heads() == [HEAD]
    if initial:
        command.upgrade(config, initial)
        with engine.begin() as connection:
            if initial == "s20_agent_capabilities":
                connection.execute(text("INSERT INTO agent_credentials "
                    "(token_hash, agent_id, scopes, expires_at, created_at, quota_start, quota_count) "
                    "VALUES ('kept-hash', 'migration-fixture', '[]', 9999999999999, 1, 0, 3)"))
            elif initial == "s20_chart_alerts":
                connection.execute(text("INSERT INTO chart_alerts "
                    "(id, request_id, request_hash, name, status, health, version, run, count, max_triggers, "
                    "effective_at, state, runtime, created_at, updated_at) "
                    "VALUES ('kept-alert', 'migration-fixture', 'fixture-hash', 'preserved', 'paused', 'ready', "
                    "1, 1, 2, 3, 1, '{}', '{}', 1, 1)"))
            elif initial == "v23_live_pricing":
                connection.execute(Instrument.__table__.insert().values(
                    id="MD:kept-history", label="kept", symbol="EURUSD",
                    calendar="ny17", precision=6))
                connection.execute(text("INSERT INTO market_datasets "
                    "(id,instrument_id,logical_symbol,identity,volume_kind) VALUES "
                    "('kept-dataset','MD:kept-history','EURUSD','{}','quantity')"))
                connection.execute(HistoryVersion.__table__.insert().values(
                    id="kept-version", dataset_id="kept-dataset", start=0, end=60000,
                    cursor=60000, status="published", manifest={"checksum": "kept"}))
    command.upgrade(config, "head")
    command.upgrade(config, "head")  # Repeat startup must be harmless.
    with engine.connect() as connection:
        assert connection.execute(text("SELECT version_num FROM alembic_version")).scalars().all() == [HEAD]
        tables = inspect(connection).get_table_names()
        assert {"chart_alerts", "chart_alert_versions", "agent_credentials", "agent_operations",
                "market_datasets", "market_history_versions", "market_live_states"} <= set(tables)
        assert {"event_key", "chart_alert_id"} <= {c["name"] for c in inspect(connection).get_columns("signals")}
        if initial == "s20_agent_capabilities":
            assert connection.execute(text("SELECT agent_id, quota_count FROM agent_credentials WHERE token_hash='kept-hash'")).one() == ("migration-fixture", 3)
        elif initial == "s20_chart_alerts":
            assert connection.execute(text("SELECT count, status FROM chart_alerts WHERE id='kept-alert'")).one() == (2, "paused")
        elif initial == "v23_live_pricing":
            assert connection.execute(text("SELECT cursor,status FROM market_history_versions "
                                           "WHERE id='kept-version'")).one() == (60000, "published")
            assert connection.execute(text("SELECT instrument_id FROM market_datasets "
                                           "WHERE id='kept-dataset'")).scalar() == "MD:kept-history"



@pytest.mark.parametrize("initial", [None, "r19_native_history_loads", "s20_chart_alerts", "s20_agent_capabilities",
                                    "u22_chart_alert_actions", "v23_live_pricing"])
def test_sqlite_upgrade_both_branches(tmp_path, monkeypatch, initial):
    engine = create_engine("sqlite:///" + str(tmp_path / "branches.db"))
    try:
        verify_upgrade_paths(engine, monkeypatch, initial)
        with engine.connect() as connection:
            assert connection.execute(text("PRAGMA foreign_key_check")).all() == []
    finally:
        engine.dispose()


def test_upgrade_existing_joined_head_backfills_control_revision(tmp_path, monkeypatch):
    engine = create_engine("sqlite:///" + str(tmp_path / "joined.db"))
    monkeypatch.setattr(settings, "database_url", engine.url.render_as_string(hide_password=False))
    config = configuration()
    try:
        command.upgrade(config, "t21_merge_alerts_mcp")
        with engine.begin() as connection:
            # s20 uses current model metadata on fresh installations. Recreate
            # the actual already-deployed t21 shape, without this new column.
            connection.execute(text("ALTER TABLE chart_alerts DROP COLUMN control_revision"))
            connection.execute(text("INSERT INTO chart_alerts "
                "(id,request_id,request_hash,name,status,health,version,run,count,max_triggers,"
                "effective_at,state,runtime,created_at,updated_at) VALUES "
                "('existing','old','hash','kept','paused','ready',2,3,1,3,1,'{}','{}',1,1)"))
        command.upgrade(config, "head")
        with engine.connect() as connection:
            assert connection.execute(text("SELECT version,run,count,control_revision FROM chart_alerts "
                                           "WHERE id='existing'")).one() == (2, 3, 1, 1)
            assert "chart_alert_actions" in inspect(connection).get_table_names()
    finally:
        engine.dispose()
