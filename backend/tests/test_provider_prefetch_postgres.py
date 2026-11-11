"""Prefetch retargeting and batched commits on a unique real PG schema."""

import os
import threading
import uuid

import pytest
from alerts import native_history_signals as signals
from alerts import provider_service as service
from alerts.storage import ProviderInterest
from sqlalchemy import select
from test_provider_cache import META, page, seed
from test_provider_postgres import provider_pg as provider_pg
from test_provider_service import (
    test_lowering_and_disabling_inflight_prefetch_cannot_resurrect_goal as check_inflight,
)

pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated PostgreSQL")


def test_inflight_config_disable_fences_worker(provider_pg, monkeypatch):
    factory, _ = provider_pg
    check_inflight(factory, monkeypatch)


def test_late_repeatable_snapshot_cannot_restart_disabled_prefetch(provider_pg, monkeypatch):
    from alerts import provider_chart as upstream
    from alerts.provider_history_policy import prefetch_capabilities, save_prefetch
    factory, _ = provider_pg
    key = seed(META, "M5", 100000, page(90000, 100000))
    paused, resume = threading.Event(), threading.Event()
    failures = []
    original = service._prefetch_target
    def pause(frame, before, goal):
        paused.set()
        assert resume.wait(3)
        return original(frame, before, goal)
    monkeypatch.setattr(service, "_prefetch_target", pause)
    def activate():
        try:
            with factory() as db:
                db.connection(execution_options={"isolation_level": "REPEATABLE READ"})
                service.activate("late-pg", key, 100000, 3, latest=True, db=db)
                db.commit()
        except BaseException as exc:
            failures.append(exc)
    thread = threading.Thread(target=activate)
    thread.start()
    try:
        assert paused.wait(3)
        values = prefetch_capabilities()["sources"]
        values["oanda"] = {"initial_bars": 0, "reserve_bars": 0}
        save_prefetch(values)
    finally:
        resume.set()
        thread.join(4)
    assert not thread.is_alive() and not failures
    monkeypatch.setattr(upstream, "native_page", lambda *a, **k: pytest.fail("disabled late activation fetched"))
    assert service.warm_step("oanda")[1] is False
    with factory() as db:
        assert db.scalar(select(ProviderInterest)).targets == []


def test_real_listen_connection_receives_only_committed_hint(provider_pg):
    factory, _ = provider_pg
    ident = str(uuid.uuid4())
    ready = threading.Event()
    # Trigger via a separate raw connection to exercise LISTEN, not local dispatch.
    from sqlalchemy import text
    try:
        with signals.watch(lambda value: ready.set() if value == ident else None):
            # LISTEN startup is asynchronous; retry a bounded set of commit hints.
            for _ in range(10):
                with factory.begin() as db:
                    db.execute(text("SELECT pg_notify(:channel, :ident)"), {"channel": signals.CHANNEL, "ident": ident})
                if ready.wait(0.2):
                    break
            assert ready.is_set(), "dedicated listener must receive a real PG notification"
    finally:
        signals.close()
    assert not signals._callbacks
