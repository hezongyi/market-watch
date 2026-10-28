"""Runtime incidents and restart loops persist on a real PostgreSQL cluster."""

import os
import threading
import uuid

import pytest
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.orm import sessionmaker

pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"),
                                reason="Requires isolated Ubuntu PostgreSQL")


@pytest.fixture
def incident_pg(monkeypatch):
    from alerts import storage

    url = os.environ["TEST_POSTGRES_URL"]
    admin = create_engine(url, pool_size=1, max_overflow=0)
    schema = "incident_" + uuid.uuid4().hex
    with admin.begin() as conn:
        conn.execute(text(f"CREATE SCHEMA {schema}"))
    isolated = create_engine(
        url, connect_args={"options": f"-csearch_path={schema}"}, pool_size=4, max_overflow=0
    )
    storage.Base.metadata.create_all(isolated)
    factory = sessionmaker(isolated, expire_on_commit=False)
    monkeypatch.setattr(storage, "Session", factory)
    try:
        yield factory, isolated
    finally:
        isolated.dispose()
        with admin.begin() as conn:
            conn.execute(text(f"DROP SCHEMA {schema} CASCADE"))
        admin.dispose()


def scope(monkeypatch, market=()):
    from alerts import runtime_health

    monkeypatch.setattr(runtime_health, "MARKET_ROLES", tuple(market))
    monkeypatch.setattr(runtime_health, "data_roles", lambda: ())
    monkeypatch.setattr(runtime_health, "NOTIFICATION_ROLES", ())


def test_restart_loop_is_deduplicated_across_worker_restarts(incident_pg, monkeypatch):
    from alerts import notification_runtime, runtime_health
    from alerts.storage import Notification, Outbox, Preference, now_ms, transaction

    scope(monkeypatch, market=("chart_alert",))
    boots = [runtime_health.Progress("market", "chart_alert", f"boot-{index}")
             for index in range(4)]
    for reporter in boots:
        reporter.claim()
    boots[-1].record()

    notification_runtime.inspect_health()
    # The restarted notification worker reads the incident instead of re-pushing it.
    notification_runtime.inspect_health()
    with transaction() as db:
        notes = list(db.scalars(select(Notification)))
        assert len(notes) == 1 and "runtime / boot_loop" in notes[0].payload["message"]
        assert db.scalar(select(func.count()).select_from(Outbox)) == 1
        incident = db.get(Preference, "runtime_incident:runtime:boot_loop")
        assert incident.value["state"] == "active"
        incident.value = {**incident.value, "last_notified_at": now_ms() - 900_000}
    notification_runtime.inspect_health()

    with transaction() as db:
        role = db.get(Preference, runtime_health.key("chart_alert"))
        role.value = {**role.value, "starts": [role.value["starts"][-1]]}
    notification_runtime.inspect_health()
    with transaction() as db:
        notes = list(db.scalars(select(Notification).order_by(Notification.created_at,
                                                             Notification.id)))
        assert len(notes) == 3 and "已恢复" in notes[-1].payload["message"]
        assert db.get(Preference, "runtime_incident:runtime:boot_loop").value["state"] == "recovered"


def test_concurrent_claims_keep_every_boot_inside_the_window(incident_pg):
    from alerts import runtime_health
    from alerts.storage import Preference, transaction

    barrier, errors = threading.Barrier(2), []

    def claim(boot):
        try:
            barrier.wait(5)
            runtime_health.Progress("market", "chart_alert", boot).claim()
        except Exception as exc:  # pragma: no cover - reported through errors
            errors.append(exc)

    threads = [threading.Thread(target=claim, args=(f"boot-{index}",)) for index in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(10)
    assert not errors
    with transaction() as db:
        starts = db.get(Preference, runtime_health.key("chart_alert")).value["starts"]
        assert len(starts) == 2 and len(runtime_health.restarts(db)) == 0


def test_maintenance_window_is_durable_and_expires(incident_pg, monkeypatch):
    from alerts import notification_runtime, runtime_health
    from alerts.storage import Notification, Preference, now_ms, transaction

    scope(monkeypatch, market=("chart_alert",))
    with transaction() as db:
        window = runtime_health.maintain(db, minutes=45, note="planned upgrade")
        assert window["until"] > now_ms()

    notification_runtime.inspect_health()
    with transaction() as db:
        assert db.scalar(select(Notification)) is None
        assert db.get(Preference, runtime_health.maintenance_key()).value["note"] == "planned upgrade"
        runtime_health.maintain(db, minutes=1, at=now_ms() - 120_000)

    notification_runtime.inspect_health()
    with transaction() as db:
        assert "market / chart_alert" in db.scalar(select(Notification)).payload["message"]
        runtime_health.clear_maintenance(db)
    with transaction() as db:
        assert db.get(Preference, runtime_health.maintenance_key()) is None
