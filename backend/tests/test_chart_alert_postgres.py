"""Real PostgreSQL concurrency/lock tests, confined to a task-owned schema."""

import os
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
from alerts.chart_alert_service import consume, create, lifecycle
from alerts.storage import ChartAlert, Notification, Outbox, SignalRow, bootstrap
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker
from test_chart_alert_migration import full_legacy_upgrade, legacy, migration
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
    # Independent Alembic engines must retain the same task-owned search_path.
    scoped_url = make_url(url).update_query_dict({"options": "-csearch_path=" + schema})
    engine = create_engine(scoped_url)

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


def test_postgres_concurrent_lifecycle_retry_opens_one_run(postgres_alerts, monkeypatch):
    from alerts.storage import ChartAlertAction, settings
    monkeypatch.setattr(settings, "fx_source", "dukascopy")
    bootstrap(postgres_alerts)
    factory = sessionmaker(postgres_alerts, expire_on_commit=False)
    with factory.begin() as db:
        ident = create(db, "pg-lifecycle", config(), at=0).id

    def attempt(_):
        with factory.begin() as db:
            return lifecycle(db, ident, 1, "restart", expected_revision=1,
                             request_id="concurrent-restart", at=100).run

    with ThreadPoolExecutor(max_workers=4) as executor:
        assert list(executor.map(attempt, range(8))) == [2] * 8
    with factory() as db:
        assert db.get(ChartAlert, ident).control_revision == 2
        assert db.scalar(select(func.count()).select_from(ChartAlertAction)) == 1


def test_postgres_concurrent_monitors_retire_legacy_once_and_preserve_delivery(postgres_alerts, monkeypatch):
    from alerts import storage
    from alerts.chart_alert_worker import step

    monkeypatch.setattr(storage.settings, "fx_source", "dukascopy")
    bootstrap(postgres_alerts)
    factory = sessionmaker(postgres_alerts, expire_on_commit=False)
    monkeypatch.setattr(storage, "Session", factory)
    with factory.begin() as db:
        row = create(db, "retire-concurrent", config(notify_ntfy=True), at=0)
        ident = row.id
        consume(db, ident, sample(0, 9), detected_at=0)
        consume(db, ident, sample(1, 11), detected_at=300000)
        before = (row.version, row.run, row.count, row.control_revision, row.state, row.runtime)
        event = db.scalar(select(SignalRow))
        signal_id, evidence = event.id, event.evidence
        task = db.scalar(select(Outbox))
        delivery = {column.name: getattr(task, column.name) for column in Outbox.__table__.columns}

    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda _: step(now=600000), range(4)))

    with factory() as db:
        row = db.get(ChartAlert, ident)
        assert row.status == "paused" and "已退役" in row.health_reason
        assert (row.version, row.run, row.count, row.state, row.runtime) == (
            before[0], before[1], before[2], before[4], before[5])
        assert row.control_revision == before[3] + 1
        assert db.get(SignalRow, signal_id).evidence == evidence
        assert db.scalar(select(func.count()).select_from(SignalRow)) == 1
        task = db.scalar(select(Outbox))
        assert {column.name: getattr(task, column.name) for column in Outbox.__table__.columns} == delivery


def test_postgres_locked_rule_is_skipped_without_evaluation_observation(postgres_alerts, monkeypatch):
    from alerts import chart_alert_worker, storage

    monkeypatch.setattr(storage.settings, "fx_source", "dukascopy")
    bootstrap(postgres_alerts)
    factory = sessionmaker(postgres_alerts, expire_on_commit=False)
    monkeypatch.setattr(storage, "Session", factory)
    with factory.begin() as db:
        ident = create(db, "locked-monitor", config(), at=0).id

    observations = []
    with factory.begin() as holder:
        row = holder.scalar(select(ChartAlert).where(ChartAlert.id == ident).with_for_update())
        assert row.status == "active"
        with ThreadPoolExecutor(max_workers=1) as pool:
            pool.submit(chart_alert_worker.step, now=600000, on_evaluated=observations.append).result(timeout=10)
        assert observations == []
        assert row.status == "active" and row.control_revision == 1

    chart_alert_worker.step(now=600000, on_evaluated=observations.append)
    assert len(observations) == 1
    assert observations[0]["alert_id"] == ident
    assert observations[0]["status"] == "paused"
    assert observations[0]["committed"] >= observations[0]["commit_started"]


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


def test_postgres_full_legacy_migration_retains_queue_and_multiple_events(postgres_alerts, monkeypatch):
    full_legacy_upgrade(postgres_alerts, monkeypatch)


@pytest.mark.parametrize("initial", [None, "r19_native_history_loads", "s20_chart_alerts", "s20_agent_capabilities"])
def test_postgres_alerts_and_mcp_upgrade_paths(postgres_alerts, monkeypatch, initial):
    from test_alerts_mcp_migration import verify_upgrade_paths
    verify_upgrade_paths(postgres_alerts, monkeypatch, initial)
