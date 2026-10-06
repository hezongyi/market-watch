"""Real PostgreSQL concurrency/lock tests, confined to a task-owned schema."""

import os
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
from alerts.chart_alert_service import consume, create
from alerts.storage import ChartAlert, Notification, Outbox, SignalRow, bootstrap
from sqlalchemy import create_engine, event, func, select, text
from sqlalchemy.orm import sessionmaker
from test_chart_alert_migration import legacy, migration
from test_chart_alert_service import config, sample


@pytest.fixture
def postgres_alerts():
    url = os.environ.get("CHART_ALERT_TEST_DATABASE_URL")
    if not url:
        pytest.skip("requires isolated Ubuntu PostgreSQL acceptance database")
    administration = create_engine(url)
    if administration.dialect.name != "postgresql":
        pytest.fail("PostgreSQL concurrency verification requires PostgreSQL")
    schema = "chart_alert_test_" + uuid.uuid4().hex
    with administration.begin() as connection:
        connection.execute(text('CREATE SCHEMA "' + schema + '"'))
    engine = create_engine(url)

    @event.listens_for(engine, "connect")
    def scoped_connection(connection, record):
        # A committed search_path prevents rollback from restoring public.
        previous = connection.autocommit
        connection.autocommit = True
        with connection.cursor() as cursor:
            cursor.execute('SET search_path TO "' + schema + '"')
        connection.autocommit = previous

    try:
        yield engine
    finally:
        engine.dispose()
        with administration.begin() as connection:
            connection.execute(text('DROP SCHEMA "' + schema + '" CASCADE'))
        administration.dispose()


def test_postgres_workers_commit_one_logical_event_with_one_outbox(postgres_alerts, monkeypatch):
    from alerts.storage import settings
    monkeypatch.setattr(settings, "fx_source", "dukascopy")
    bootstrap(postgres_alerts)
    factory = sessionmaker(postgres_alerts, expire_on_commit=False)
    with factory.begin() as db:
        ident = create(db, "pg-concurrency", config(notify_ntfy=True), at=0).id
        consume(db, ident, sample(0, 9), detected_at=0)

    def attempt():
        with factory.begin() as db:
            result = consume(db, ident, sample(1, 11), detected_at=300_000)
            return result.id if result else None

    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(lambda _: attempt(), range(8)))
    assert len([r for r in results if r]) == 1
    with factory() as db:
        assert db.get(ChartAlert, ident).count == 1
        assert db.get(ChartAlert, ident).state["sequence"] == 1
        assert db.scalar(select(func.count()).select_from(SignalRow)) == 1
        assert db.scalar(select(func.count()).select_from(Notification)) == 1
        assert db.scalar(select(func.count()).select_from(Outbox)) == 1


def test_postgres_populated_legacy_upgrade_preserves_foreign_keys(postgres_alerts):
    with postgres_alerts.begin() as connection:
        legacy(connection)
        module = migration(connection)
        module.upgrade()
        assert connection.execute(text("SELECT id, watch_id, event_key FROM signals")).one() == (
            "old-signal", "old-watch", "old-signal",
        )
        assert connection.execute(text("SELECT * FROM notifications")).one() == ("old-note", "old-signal")
        module.downgrade()
        assert connection.execute(text("SELECT id, watch_id FROM signals")).one() == ("old-signal", "old-watch")
