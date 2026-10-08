"""Real confirmation and publication transactions must not invert row locks."""

import os
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from alerts import live_pricing as live
from alerts import managed_dataset, publication_schedule
from alerts.config import settings
from alerts.history_retention import reclaim
from alerts.storage import ChartHistoryPlan, ChartPublicationState, MarketDataset, PricingOwner
from sqlalchemy import event, select
from sqlalchemy.exc import OperationalError
from test_history_retention import prepared
from test_live_pricing import candles
from test_market_contracts import identity
from test_market_datasets import register
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(
    not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated Ubuntu PostgreSQL"
)


@pytest.mark.parametrize("status", ["pending", "complete", "cancelled"])
def test_publisher_plan_progress_does_not_deadlock_confirmed_pricing(provider_pg, monkeypatch, status):
    factory, engine = provider_pg
    monkeypatch.setattr(settings, "oanda_resident_symbols", "EUR_USD")
    monkeypatch.setattr(settings, "oanda_recovery_minutes", 2)
    monkeypatch.setattr(live, "now_ms", lambda: 125000)
    monkeypatch.setattr(managed_dataset, "now_ms", lambda: 125000)
    monkeypatch.setattr(publication_schedule, "discover", lambda *_: None)
    live.ensure_catalog([
        {"name": "EUR_USD", "type": "CURRENCY", "displayPrecision": 5},
    ], "deadlock-regression-account")
    identities = live.desired_datasets("deadlock-regression-account")
    identity = identities["EUR_USD"]
    ownership = live.claim("deadlock-regression-account")
    epoch = live.begin_connection(ownership, identities)
    live.commit_confirmation(ownership, epoch, candles(identity), now=125000)
    with factory.begin() as db:
        instrument_id = db.get(MarketDataset, identity.key).instrument_id
        db.add(ChartHistoryPlan(
            instrument_id=instrument_id, target_start=0, target_end=120000,
            cursor=120000, realtime_end=0, status=status, realtime_enabled=True,
        ))
        db.flush()
        publication_schedule.request(db, instrument_id, frames=("M1",), approved=True)
        db.get(ChartPublicationState, (instrument_id, "M1")).next_at = 125000

    publisher_locked = threading.Event()
    confirmation_locked = threading.Event()
    original_publisher = managed_dataset.publish_frame

    def publish(db, inst, plan, frame, stamp):
        # tick has already acquired its production Instrument lock. A real
        # confirmation now takes its dataset lock before requesting Instrument.
        publisher_locked.set()
        assert confirmation_locked.wait(5)
        return original_publisher(db, inst, plan, frame, stamp)

    def observe_lock(connection, cursor, statement, parameters, context, executemany):
        if (threading.current_thread().name.startswith("confirmation")
                and "FROM market_datasets" in statement and "FOR UPDATE" in statement):
            confirmation_locked.set()

    event.listen(engine, "after_cursor_execute", observe_lock)
    try:
        with ThreadPoolExecutor(max_workers=1, thread_name_prefix="publisher") as publisher_pool:
            published = publisher_pool.submit(publication_schedule.tick, publish,
                                              managed_dataset.publish_corrections)
            assert publisher_locked.wait(5)
            with ThreadPoolExecutor(max_workers=1, thread_name_prefix="confirmation") as pricing_pool:
                confirmed = pricing_pool.submit(live.commit_confirmation, ownership, epoch,
                                                candles(identity), now=125000)
                pricing_error = None
                try:
                    confirmed.result(timeout=10)
                except Exception as error:
                    pricing_error = error
                result = published.result(timeout=10)
        assert pricing_error is None, f"pricing transaction aborted: {pricing_error}"
        assert result.blocked_reason != "OperationalError", "publication hit a PostgreSQL deadlock"
        with factory.begin() as db:
            assert db.get(ChartHistoryPlan, instrument_id).realtime_end == 120000
            assert db.get(PricingOwner, ownership[0]).epoch == epoch
    finally:
        event.remove(engine, "after_cursor_execute", observe_lock)


@pytest.mark.parametrize("change", [
    "create", "status", "realtime_enabled", "instrument_id", "inactive_progress",
])
def test_plan_reference_changes_still_fence_dataset_reclamation(provider_pg, change):
    factory, _ = provider_pg
    with factory.begin() as db:
        original = register(db)
        destination = register(db, identity(channel="node"))
        original_id, destination_id = original.id, destination.id
        if change != "create":
            db.add(ChartHistoryPlan(
                instrument_id=original_id, target_start=0, target_end=120000,
                cursor=120000, status="cancelled", realtime_enabled=False,
            ))

    with factory.begin() as writer:
        if change == "create":
            plan = ChartHistoryPlan(
                instrument_id=original_id, target_start=0, target_end=120000,
                cursor=120000, status="pending", realtime_enabled=True,
            )
            writer.add(plan)
        else:
            plan = writer.get(ChartHistoryPlan, original_id)
            if change == "inactive_progress":
                plan.realtime_end = 120000
            else:
                setattr(plan, change, {"status": "pending", "realtime_enabled": True,
                                      "instrument_id": destination_id}[change])
        writer.flush()
        dataset_id = identity(channel="node").key if change == "instrument_id" else identity().key
        # The actual reclamation row lock must be excluded while the new or
        # reactivated reference remains uncommitted, including rebinding.
        with factory.begin() as reclaiming:
            with pytest.raises(OperationalError) as blocked:
                reclaiming.scalar(select(MarketDataset).where(MarketDataset.id == dataset_id)
                                  .with_for_update(nowait=True))
            assert blocked.value.orig.sqlstate == "55P03"


@pytest.mark.parametrize("status,realtime_enabled", [
    ("pending", False), ("complete", False), ("cancelled", True),
])
def test_existing_plan_progress_still_prevents_actual_reclamation(provider_pg, status, realtime_enabled):
    factory, _ = provider_pg
    _, instrument_id = prepared(factory)
    with factory.begin() as db:
        db.add(ChartHistoryPlan(
            instrument_id=instrument_id, target_start=0, target_end=120000,
            cursor=120000, realtime_end=0, status=status, realtime_enabled=realtime_enabled,
        ))

    with factory.begin() as publishing:
        plan = publishing.get(ChartHistoryPlan, instrument_id)
        plan.realtime_end = 120000
        publishing.flush()
        with factory.begin() as reclaiming:
            with pytest.raises(ValueError, match="引用"):
                reclaim(reclaiming, identity().key, "while-plan-progresses")
