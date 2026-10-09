"""Real PostgreSQL lifecycle races; each test owns a disposable schema."""

import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
from alerts import market_stream as stream
from alerts.storage import MarketStreamClient, MarketStreamSubscription, MarketStreamTask
from sqlalchemy import create_engine, event, select, text
from test_market_stream import session
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"),
                               reason="Requires isolated Ubuntu PostgreSQL")


def register(owner, client, listener="chart", identity=None, generation=1):
    return stream.register(owner, client, listener, generation,
        identity or {"kind": "bars", "series_kind": "history", "dataset": "fixed"},
        {"instrument": "EURUSD", "timeframe": "M1"}, {})


def freeze_clock(monkeypatch):
    clock = [stream.now_ms()]
    monkeypatch.setattr(stream, "now_ms", lambda: clock[0])
    return clock


def test_expired_binding_registration_and_cleanup_do_not_deadlock(provider_pg, monkeypatch):
    factory, engine = provider_pg
    clock = freeze_clock(monkeypatch)
    owner = session(factory)
    binding = register(owner, "reconnecting")
    clock[0] += stream.LEASE_MS + 1
    task_locked, proceed = threading.Event(), threading.Event()

    def observe(conn, cursor, statement, parameters, context, many):
        if threading.current_thread().name == "lifecycle-register" and (
                statement.startswith("SELECT market_stream_tasks") and "FOR UPDATE" in statement):
            task_locked.set()
            assert proceed.wait(5), "cleanup must finish or reach its subscription deletion"
        if threading.current_thread().name == "lifecycle-cleanup" and (
                statement.startswith("DELETE FROM market_stream_subscriptions")):
            # Old cleanup holds Subscription while register holds Task. Fixed
            # cleanup skips the busy client/task and instead signals on return.
            proceed.set()

    def reconnect():
        threading.current_thread().name = "lifecycle-register"
        return register(owner, "reconnecting")

    def cleanup():
        threading.current_thread().name = "lifecycle-cleanup"
        assert task_locked.wait(5)
        try:
            stream.cleanup()
        finally:
            proceed.set()

    event.listen(engine, "after_cursor_execute", observe)
    pool = ThreadPoolExecutor(max_workers=2)
    try:
        reconnecting, cleaning = pool.submit(reconnect), pool.submit(cleanup)
        assert reconnecting.result(timeout=15)["task_id"] == binding["task_id"]
        cleaning.result(timeout=15)
    finally:
        proceed.set()
        pool.shutdown(wait=True)
        event.remove(engine, "after_cursor_execute", observe)
    with factory.begin() as db:
        assert db.get(MarketStreamTask, binding["task_id"])
        sub = db.scalar(select(MarketStreamSubscription))
        assert sub.active and sub.expires > clock[0]
        assert db.get(MarketStreamClient, sub.client_id).expires > clock[0]


def test_multitask_renewal_and_other_page_replacement_lock_tasks_consistently(provider_pg, monkeypatch):
    factory, engine = provider_pg
    clock = freeze_clock(monkeypatch)
    owner = session(factory)
    low, high = sorted([
        {"kind": "bars", "series_kind": "history", "dataset": str(index)}
        for index in range(2)], key=stream.digest)
    high_id = register(owner, "renew-page", "high", high)["task_id"]
    low_id = register(owner, "renew-page", "low", low)["task_id"]
    register(owner, "replace-page", identity=high)
    clock[0] += stream.LEASE_MS * 2 // 3
    # A normal worker UPDATE can move tuples. Arrange a legal heap order that
    # differs from the Task.id order; UPDATE ... IN does not promise lock order.
    with engine.begin() as conn:
        conn.execute(text("UPDATE market_stream_tasks SET next_at=1 WHERE id=:id"), {"id": low_id})
    gate = uuid.uuid4().int % (2 ** 63)
    with engine.begin() as conn:
        conn.execute(text("""
            CREATE FUNCTION lifecycle_pause_update() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                IF current_setting('application_name') = 'lifecycle-renew'
                   AND NEW.id = '""" + high_id + """' THEN
                    PERFORM pg_advisory_xact_lock(""" + str(gate) + """);
                END IF;
                RETURN NEW;
            END $$
        """))
        conn.execute(text("CREATE TRIGGER lifecycle_pause BEFORE UPDATE ON market_stream_tasks "
                          "FOR EACH ROW EXECUTE FUNCTION lifecycle_pause_update()"))
    # This connection is separate from the fixture's two worker connections.
    controller_engine = create_engine(engine.url)
    control = controller_engine.connect()
    control.execute(text("SELECT pg_advisory_lock(:gate)"), {"gate": gate})
    control.commit()

    def name_connection(conn):
        name = threading.current_thread().name
        if name in ("lifecycle-renew", "lifecycle-replace"):
            conn.exec_driver_sql("SET LOCAL application_name = '" + name + "'")

    def wait_for(name, wait_event):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            waiting = control.scalar(text("SELECT count(*) FROM pg_stat_activity "
                "WHERE application_name=:name AND wait_event=:event"),
                {"name": name, "event": wait_event})
            control.commit()
            if waiting:
                return
            time.sleep(.02)
        raise AssertionError(f"{name} did not reach {wait_event}")

    def renew():
        threading.current_thread().name = "lifecycle-renew"
        stream.renew(owner, "renew-page")

    def replace():
        threading.current_thread().name = "lifecycle-replace"
        return register(owner, "replace-page", identity=low, generation=2)

    event.listen(engine, "begin", name_connection)
    pool = ThreadPoolExecutor(max_workers=2)
    try:
        renewing = pool.submit(renew)
        wait_for("lifecycle-renew", "advisory")
        replacing = pool.submit(replace)
        wait_for("lifecycle-replace", "transactionid")
        control.execute(text("SELECT pg_advisory_unlock(:gate)"), {"gate": gate})
        control.commit()
        renewing.result(timeout=15)
        assert replacing.result(timeout=15)["task_id"] == low_id
    finally:
        # Release the pause before joining threads even when a wait/assertion
        # fails, so executor teardown cannot trap a worker on our own gate.
        control.execute(text("SELECT pg_advisory_unlock(:gate)"), {"gate": gate})
        control.commit()
        pool.shutdown(wait=True)
        event.remove(engine, "begin", name_connection)
        control.close()
        controller_engine.dispose()
    with factory.begin() as db:
        for sub in db.scalars(select(MarketStreamSubscription)):
            assert sub.active and sub.expires > clock[0]
            assert db.get(MarketStreamTask, sub.task_id).expires >= sub.expires


@pytest.mark.parametrize("busy_row", ["client", "task"])
@pytest.mark.parametrize("shared_task", [False, True])
def test_cleanup_skips_busy_resources_and_preserves_other_clients(
        provider_pg, monkeypatch, busy_row, shared_task):
    factory, _ = provider_pg
    clock = freeze_clock(monkeypatch)
    owner = session(factory)
    busy = register(owner, "busy")
    register(owner, "retained", identity=None if shared_task else {
        "kind": "bars", "series_kind": "history", "dataset": "retained"})
    expired = register(owner, "expired", identity={
        "kind": "bars", "series_kind": "history", "dataset": "unused"})
    clock[0] += stream.LEASE_MS - 1000
    stream.renew(owner, "retained")
    clock[0] += 2000
    blocker = factory()
    model, key = ((MarketStreamClient, stream.client_key(owner, "busy")) if busy_row == "client"
                  else (MarketStreamTask, busy["task_id"]))
    blocker.get(model, key, with_for_update=True)
    pool = ThreadPoolExecutor(max_workers=1)
    try:
        future = pool.submit(stream.cleanup)
        future.result(timeout=3)
    finally:
        blocker.rollback()
        blocker.close()
        pool.shutdown(wait=True)
    stream.cleanup()
    with factory.begin() as db:
        retained = db.scalar(select(MarketStreamSubscription).where(
            MarketStreamSubscription.client_id == stream.client_key(owner, "retained")))
        assert retained.active and retained.expires > clock[0]
        assert db.get(MarketStreamTask, retained.task_id)
        assert db.get(MarketStreamClient, retained.client_id)
        assert not db.get(MarketStreamTask, expired["task_id"])
        assert not db.get(MarketStreamClient, stream.client_key(owner, "expired"))
        assert not db.get(MarketStreamClient, stream.client_key(owner, "busy"))


def test_registration_survives_concurrent_orphan_task_retirement(provider_pg, monkeypatch):
    factory, engine = provider_pg
    clock = freeze_clock(monkeypatch)
    owner = session(factory)
    old = register(owner, "retiring")
    stream.cancel(owner, "retiring", "chart", 1)
    clock[0] += stream.LEASE_MS + 1
    task_checked, cleaned = threading.Event(), threading.Event()

    def observe(conn, cursor, statement, parameters, context, many):
        if threading.current_thread().name == "lifecycle-new-client" and not task_checked.is_set() and (
                statement.startswith("INSERT INTO market_stream_tasks") or
                statement.startswith("SELECT market_stream_tasks") and "FOR UPDATE" in statement):
            # The old INSERT conflict check owns no task row lock; cleanup can
            # retire it before the SELECT. A lock-first implementation instead
            # protects the existing row, allowing cleanup to skip and return.
            task_checked.set()
            assert cleaned.wait(5), "cleanup must retire or skip the task and return"

    def subscribe():
        threading.current_thread().name = "lifecycle-new-client"
        return register(owner, "new-page")

    def cleanup():
        assert task_checked.wait(5)
        try:
            stream.cleanup()
        finally:
            cleaned.set()

    event.listen(engine, "after_cursor_execute", observe)
    pool = ThreadPoolExecutor(max_workers=2)
    try:
        subscribing, cleaning = pool.submit(subscribe), pool.submit(cleanup)
        assert subscribing.result(timeout=15)["task_id"] == old["task_id"]
        cleaning.result(timeout=15)
    finally:
        cleaned.set()
        pool.shutdown(wait=True)
        event.remove(engine, "after_cursor_execute", observe)
    with factory.begin() as db:
        sub = db.scalar(select(MarketStreamSubscription).where(
            MarketStreamSubscription.client_id == stream.client_key(owner, "new-page")))
        assert sub.active and sub.expires > clock[0]
        assert db.get(MarketStreamTask, sub.task_id).expires >= sub.expires


def test_registration_survives_concurrent_expired_client_retirement(provider_pg, monkeypatch):
    factory, engine = provider_pg
    clock = freeze_clock(monkeypatch)
    owner = session(factory)
    old = register(owner, "returning-page")
    stream.cancel(owner, "returning-page", "chart", 1)
    clock[0] += stream.LEASE_MS + 1
    client_checked, cleaned = threading.Event(), threading.Event()

    def observe(conn, cursor, statement, parameters, context, many):
        if threading.current_thread().name == "lifecycle-returning-client" and not client_checked.is_set() and (
                statement.startswith("INSERT INTO market_stream_clients") or
                statement.startswith("SELECT market_stream_clients") and "FOR UPDATE" in statement):
            client_checked.set()
            assert cleaned.wait(5), "cleanup must retire or skip the client and return"

    def subscribe():
        threading.current_thread().name = "lifecycle-returning-client"
        return register(owner, "returning-page", generation=2)

    def cleanup():
        assert client_checked.wait(5)
        try:
            stream.cleanup()
        finally:
            cleaned.set()

    event.listen(engine, "after_cursor_execute", observe)
    pool = ThreadPoolExecutor(max_workers=2)
    try:
        subscribing, cleaning = pool.submit(subscribe), pool.submit(cleanup)
        assert subscribing.result(timeout=15)["task_id"] == old["task_id"]
        cleaning.result(timeout=15)
    finally:
        cleaned.set()
        pool.shutdown(wait=True)
        event.remove(engine, "after_cursor_execute", observe)
    with factory.begin() as db:
        client = db.get(MarketStreamClient, stream.client_key(owner, "returning-page"))
        sub = db.scalar(select(MarketStreamSubscription).where(
            MarketStreamSubscription.client_id == client.id))
        assert client.expires > clock[0]
        assert sub.active and sub.generation == 2 and sub.expires > clock[0]
        assert db.get(MarketStreamTask, sub.task_id).expires >= sub.expires


def test_live_cancellation_tombstone_does_not_block_orphan_task_reclamation(provider_pg, monkeypatch):
    factory, _ = provider_pg
    clock = freeze_clock(monkeypatch)
    owner = session(factory)
    orphan = register(owner, "retired-page")
    stream.cancel(owner, "retired-page", "chart", 1)
    clock[0] += stream.LEASE_MS + 1
    # A cancellation may precede its first registration. Its NULL task binding
    # remains a valid generation fence while an unrelated orphan is reclaimed.
    stream.cancel(owner, "current-page", "late-listener", 2)
    stream.cleanup()
    with factory.begin() as db:
        assert not db.get(MarketStreamTask, orphan["task_id"])
        assert not db.get(MarketStreamClient, stream.client_key(owner, "retired-page"))
        tombstone = db.scalar(select(MarketStreamSubscription))
        assert tombstone.client_id == stream.client_key(owner, "current-page")
        assert not tombstone.active and tombstone.task_id is None
        assert tombstone.generation == 2 and tombstone.expires > clock[0]
        assert db.get(MarketStreamClient, tombstone.client_id)
