"""Upgrade populated legacy storage, retaining event and notification identity."""

import importlib.util
from pathlib import Path

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text


def migration(connection):
    path = Path(__file__).resolve().parents[2] / "migrations/versions/s20_chart_alerts.py"
    spec = importlib.util.spec_from_file_location("chart_alert_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.op = Operations(MigrationContext.configure(connection))
    return module


def legacy(connection):
    connection.execute(text("CREATE TABLE provider_datasets (id VARCHAR(64) PRIMARY KEY)"))
    connection.execute(text("CREATE TABLE watches (id VARCHAR(36) PRIMARY KEY)"))
    connection.execute(text("CREATE TABLE signals (id VARCHAR(36) PRIMARY KEY, "
                            "watch_id VARCHAR(36) NOT NULL UNIQUE REFERENCES watches(id), "
                            "evidence JSON NOT NULL)"))
    connection.execute(text("CREATE TABLE notifications (id VARCHAR(36) PRIMARY KEY, "
                            "signal_id VARCHAR(36) UNIQUE REFERENCES signals(id))"))
    connection.execute(text("INSERT INTO watches VALUES ('old-watch')"))
    connection.execute(text("INSERT INTO signals VALUES ('old-signal', 'old-watch', '{\"price\":\"1.23\"}')"))
    connection.execute(text("INSERT INTO notifications VALUES ('old-note', 'old-signal')"))


def test_upgrade_retains_legacy_signal_evidence_and_notification_then_roundtrips(tmp_path):
    engine = create_engine("sqlite:///" + str(tmp_path / "legacy.db"))
    with engine.begin() as connection:
        legacy(connection)
        module = migration(connection)
        module.upgrade()
        assert connection.execute(text("SELECT id, watch_id, event_key, evidence FROM signals")).one() == (
            "old-signal", "old-watch", "old-signal", '{"price":"1.23"}',
        )
        assert connection.execute(text("SELECT * FROM notifications")).one() == ("old-note", "old-signal")
        uniques = inspect(connection).get_unique_constraints("signals")
        assert [c["column_names"] for c in uniques] == [["event_key"]]
        module.downgrade()
        assert "chart_alerts" not in inspect(connection).get_table_names()
        assert [c["column_names"] for c in inspect(connection).get_unique_constraints("signals")] == [["watch_id"]]
        assert connection.execute(text("SELECT id, evidence FROM signals")).one() == (
            "old-signal", '{"price":"1.23"}',
        )
        module.upgrade()


def test_downgrade_refuses_to_discard_chart_alert_data(tmp_path):
    engine = create_engine("sqlite:///" + str(tmp_path / "protected.db"))
    with engine.begin() as connection:
        legacy(connection)
        module = migration(connection)
        module.upgrade()
        connection.execute(text("INSERT INTO chart_alerts (id, request_id, request_hash, name, "
                                "status, health, version, run, count, max_triggers, "
                                "effective_at, state, runtime, created_at, updated_at) VALUES "
                                "('new', 'req', 'hash', 'alert', 'active', 'warming', "
                                "1, 1, 0, 2, 0, '{}', '{}', 0, 0)"))
        with pytest.raises(RuntimeError, match="backup"):
            module.downgrade()
        assert connection.execute(text("SELECT count(*) FROM chart_alerts")).scalar() == 1
