"""Capacity serialization and cancellation on isolated real PostgreSQL schemas."""

import os
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from alerts import fixed_indicators as jobs
from alerts import indicator_demands as demands
from alerts.chart_api import DataQuery, data_sync
from alerts.publication_wakeup import PublicationWakeup
from alerts.storage import FixedIndicatorRun
from sqlalchemy import func, select
from test_fixed_indicators import history
from test_indicator_demands import (
    test_cancel_at_expired_capacity_still_fences_late_http as check_expired,
)
from test_indicator_demands import (
    test_canceled_consumers_do_not_consume_active_capacity as check_active,
)
from test_indicator_demands import (
    test_full_cancel_budget_preserves_evicted_fence_and_live_consumers as check_full,
)
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated PostgreSQL")


def test_same_spec_waiter_reuses_last_pending_slot(provider_pg, monkeypatch):
    factory, _ = provider_pg
    version = history(factory, monkeypatch, count=100)
    page = data_sync(DataQuery(instrument=version, series_kind="history", timeframe="M1", limit=7))
    monkeypatch.setattr(demands, "MAX_PENDING_RUNS", 1)
    ready = threading.Barrier(2)
    original = demands.guard

    def competing_readers(db):
        ready.wait(timeout=5)
        original(db)

    monkeypatch.setattr(demands, "guard", competing_readers)

    def request():
        with factory.begin() as db:
            return jobs.request(db, page, {"name": "EMA", "params": {"period": 23}}).id

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(request) for _ in range(2)]
        identifiers = [future.result(timeout=10) for future in futures]
    assert identifiers[0] == identifiers[1]
    with factory.begin() as db:
        assert db.scalar(select(func.count()).select_from(FixedIndicatorRun)) == 1


@pytest.mark.parametrize("check", [check_expired, check_active, check_full])
def test_postgres_cancellation_budgets(provider_pg, monkeypatch, check):
    factory, _ = provider_pg
    check(factory, monkeypatch)


def test_new_run_wakes_worker_only_after_committed_enqueue(provider_pg, monkeypatch):
    factory, engine = provider_pg
    version = history(factory, monkeypatch, count=100)
    page = data_sync(DataQuery(instrument=version, series_kind="history", timeframe="M1", limit=7))
    with PublicationWakeup(engine) as wake:
        with factory.begin() as db:
            jobs.request(db, page, {"name": "EMA", "params": {"period": 23}})
            assert wake.wait(.05) == "timer"
        assert wake.wait(2) == "notification"
        wake.prepare()
        with factory.begin() as db:
            jobs.request(db, page, {"name": "EMA", "params": {"period": 23}})
        assert wake.wait(.05) == "timer", "polling an existing run must not flood notifications"
        with factory() as db:
            jobs.request(db, page, {"name": "EMA", "params": {"period": 24}})
            db.rollback()
        assert wake.wait(.05) == "timer"
