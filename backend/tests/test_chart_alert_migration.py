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


def full_legacy_upgrade(engine, monkeypatch):
    """Exercise the real migration chain and populated legacy queue, not toy DDL."""
    from decimal import Decimal

    from alembic import command
    from alembic.config import Config
    from alerts.chart_alert_service import consume, create
    from alerts.config import settings
    from alerts.storage import ChartAlert, Instrument, Notification, Outbox, SignalRow, Watch
    from sqlalchemy import MetaData, Table, select
    from sqlalchemy.orm import sessionmaker
    from test_chart_alert_service import config, sample

    root = Path(__file__).resolve().parents[2]
    alembic = Config(str(root / "alembic.ini"))
    alembic.set_main_option("script_location", str(root / "migrations"))
    monkeypatch.setattr(settings, "database_url", engine.url.render_as_string(hide_password=False))
    monkeypatch.setattr(settings, "fx_source", "dukascopy")
    command.upgrade(alembic, "r19_native_history_loads")
    factory = sessionmaker(engine, expire_on_commit=False)
    with factory.begin() as db:
        db.add(Instrument(id="EURUSD", label="EUR/USD", source="dukascopy", symbol="EURUSD",
                          basis="bid", calendar="ny17", precision=5))
        db.flush()
        db.add(Watch(id="legacy-watch", instrument_id="EURUSD", name="legacy", rule={},
                     state={}, status="signalled", armed_at=0))
    old_signals = Table("signals", MetaData(), autoload_with=engine)
    with engine.begin() as connection:
        connection.execute(old_signals.insert().values(
            id="legacy-signal", watch_id="legacy-watch", instrument_id="EURUSD",
            occurred_at=300_000, created_at=300_001, direction="up", price=Decimal("11"),
            threshold=Decimal("10"), reason="legacy evidence", evidence={"legacy": ["kept", 1]},
        ))
    with factory.begin() as db:
        db.add(Notification(id="legacy-note", signal_id="legacy-signal", status="pending"))
        db.flush()
        db.add(Outbox(id="legacy-outbox", notification_id="legacy-note", status="pending",
                      attempts=2, next_at=600_000, error="isolated retry"))
    command.upgrade(alembic, "head")
    with factory.begin() as db:
        old = db.get(SignalRow, "legacy-signal")
        assert old.watch_id == "legacy-watch" and old.event_key == old.id
        assert old.chart_alert_id is None and old.evidence == {"legacy": ["kept", 1]}
        assert db.get(Notification, "legacy-note").signal_id == old.id
        queue = db.get(Outbox, "legacy-outbox")
        assert (queue.notification_id, queue.attempts, queue.next_at, queue.error) == (
            "legacy-note", 2, 600_000, "isolated retry",
        )
        ident = create(db, "full-migration", config(notify_ntfy=True), at=0).id
        consume(db, ident, sample(0, 9), detected_at=0)
        for i, price in enumerate([11, 9, 11, 9, 11], 1):
            consume(db, ident, sample(i, price), detected_at=i*300_000)
        assert db.get(ChartAlert, ident).status == "completed"
        assert len(list(db.scalars(select(SignalRow).where(SignalRow.chart_alert_id == ident)))) == 3
    with pytest.raises(RuntimeError, match="backup"):
        command.downgrade(alembic, "r19_native_history_loads")
    with engine.connect() as connection:
        assert connection.execute(text("SELECT version_num FROM alembic_version")).scalar() == "t21_merge_alerts_mcp"
        assert connection.execute(text("SELECT count(*) FROM signals")).scalar() == 4


def test_full_sqlite_migration_retains_legacy_queue_and_allows_multiple_new_events(tmp_path, monkeypatch):
    engine = create_engine("sqlite:///" + str(tmp_path / "full-upgrade.db"))
    try:
        full_legacy_upgrade(engine, monkeypatch)
        with engine.connect() as connection:
            assert connection.execute(text("PRAGMA foreign_key_check")).all() == []
    finally:
        engine.dispose()


def test_migrated_alert_backup_preserves_rule_checkpoint_evidence_and_retry_queue(tmp_path, monkeypatch):
    from alerts import backup
    from alerts.storage import ChartAlert, ChartAlertVersion, Notification, Outbox, SignalRow
    from sqlalchemy import select

    source = create_engine("sqlite:///" + str(tmp_path / "backup-source.db"))
    restored = None
    try:
        full_legacy_upgrade(source, monkeypatch)
        models = (ChartAlert, ChartAlertVersion, SignalRow, Notification, Outbox)

        def contents(engine):
            with engine.connect() as connection:
                return {model.__tablename__: list(connection.execute(
                    select(model.__table__).order_by(model.__table__.c.id),
                ).mappings()) for model in models}

        expected = contents(source)
        destination = tmp_path / "isolated-alert-backup.db"
        report = backup.backup(destination)
        assert report["counts"]["signals"] == report["counts"]["outbox"] == 4
        assert backup.restore_check(destination)["verified"]
        source.dispose()
        restored = create_engine("sqlite:///" + str(destination))
        assert contents(restored) == expected
    finally:
        source.dispose()
        if restored:
            restored.dispose()
