"""Real confirmation and publication transactions must not invert row locks."""

import os
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from alerts import chart_history_plan, managed_dataset, publication_schedule
from alerts import live_pricing as live
from alerts.config import settings
from alerts.history_retention import reclaim
from alerts.market import ingest
from alerts.realtime_switch import set_enabled
from alerts.storage import (
    ChartHistoryPlan,
    ChartPublicationState,
    Instrument,
    MarketDataset,
    PricingOwner,
)
from sqlalchemy import event, select
from sqlalchemy.exc import OperationalError
from test_history_retention import prepared
from test_live_pricing import candles
from test_market_contracts import batch, identity
from test_market_datasets import register
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(
    not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated Ubuntu PostgreSQL"
)


@pytest.mark.parametrize("status", ["pending", "complete", "cancelled"])
@pytest.mark.parametrize("realtime_enabled", [True, False])
def test_publisher_plan_progress_does_not_deadlock_confirmed_pricing(
    provider_pg, monkeypatch, status, realtime_enabled
):
    factory, engine = provider_pg
    monkeypatch.setattr(settings, "oanda_resident_symbols", "EUR_USD")
    monkeypatch.setattr(settings, "oanda_recovery_minutes", 2)
    monkeypatch.setattr(live, "now_ms", lambda: 125000)
    monkeypatch.setattr(managed_dataset, "now_ms", lambda: 125000)
    monkeypatch.setattr(publication_schedule, "discover", lambda *_: None)
    live.ensure_catalog([
        {"name": "EUR_USD", "type": "CURRENCY", "displayPrecision": 5},
    ], "deadlock-regression-account")
    with factory.begin() as db:
        dataset = next(row for row in db.scalars(select(MarketDataset))
                       if row.identity.get("provider_symbol") == "EUR_USD")
        set_enabled(db, dataset.instrument_id, True, now=125000)
    identities = live.desired_datasets("deadlock-regression-account")
    identity = identities["EUR_USD"]
    ownership = live.claim("deadlock-regression-account")
    epoch = live.begin_connection(ownership, identities)
    live.commit_confirmation(ownership, epoch, candles(identity), now=125000)
    with factory.begin() as db:
        instrument_id = db.get(MarketDataset, identity.key).instrument_id
        db.add(ChartHistoryPlan(
            instrument_id=instrument_id, target_start=0, target_end=120000,
            cursor=120000, realtime_end=0, status=status, realtime_enabled=realtime_enabled,
        ))
        db.flush()
        publication_schedule.request(db, instrument_id, frames=("M1",), approved=True)
        db.get(ChartPublicationState, (instrument_id, "M1")).next_at = 125000

    publisher_locked = threading.Event()
    confirmation_locked = threading.Event()
    publisher_dataset_locked = threading.Event()
    original_publisher = managed_dataset.publish_frame

    def publish(db, inst, plan, frame, stamp):
        # Legacy publishers own only Instrument here; confirmation can take
        # Dataset and expose the inverse flush lock. Ordered publishers own
        # Dataset too, so rendezvous on the confirmation's attempted lock.
        publisher_locked.set()
        assert confirmation_locked.wait(5)
        return original_publisher(db, inst, plan, frame, stamp)

    def observe_lock(connection, cursor, statement, parameters, context, executemany):
        if (threading.current_thread().name.startswith("publisher")
                and "FROM market_datasets" in statement and "FOR UPDATE" in statement):
            publisher_dataset_locked.set()
        if (threading.current_thread().name.startswith("confirmation")
                and "FROM market_datasets" in statement and "FOR UPDATE" in statement):
            confirmation_locked.set()

    def observe_attempt(connection, cursor, statement, parameters, context, executemany):
        if (publisher_dataset_locked.is_set()
                and threading.current_thread().name.startswith("confirmation")
                and "FROM market_datasets" in statement and "FOR UPDATE" in statement):
            confirmation_locked.set()

    event.listen(engine, "after_cursor_execute", observe_lock)
    event.listen(engine, "before_cursor_execute", observe_attempt)
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
        event.remove(engine, "before_cursor_execute", observe_attempt)


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


@pytest.mark.parametrize("action", ["complete", "cancel", "resume", "join", "reactivate", "adopt"])
def test_plan_lifecycle_does_not_deadlock_confirmed_pricing(provider_pg, monkeypatch, action):
    factory, engine = provider_pg
    monkeypatch.setattr(settings, "oanda_resident_symbols", "EUR_USD")
    monkeypatch.setattr(settings, "oanda_recovery_minutes", 2)
    monkeypatch.setattr(live, "now_ms", lambda: 125000)
    live.ensure_catalog([{"name": "EUR_USD", "type": "CURRENCY", "displayPrecision": 5}],
                        "plan-completion-account")
    with factory.begin() as db:
        dataset = next(row for row in db.scalars(select(MarketDataset))
                       if row.identity.get("provider_symbol") == "EUR_USD")
        set_enabled(db, dataset.instrument_id, True, now=125000)
    identities = live.desired_datasets("plan-completion-account")
    identity = identities["EUR_USD"]
    ownership = live.claim("plan-completion-account")
    epoch = live.begin_connection(ownership, identities)
    live.commit_confirmation(ownership, epoch, candles(identity), now=125000)
    with factory.begin() as db:
        instrument_id = db.get(MarketDataset, identity.key).instrument_id
        if action not in ("join", "adopt"):
            db.add(ChartHistoryPlan(instrument_id=instrument_id, target_start=0,
                target_end=120000, cursor=120000,
                status="cancelled" if action in ("resume", "reactivate") else "pending",
                realtime_enabled=action != "reactivate"))
            db.flush()
            if action == "reactivate":
                set_enabled(db, instrument_id, True, now=125000)

    confirmation_locked = threading.Event()
    plan_at_lock = threading.Event()

    def before_sql(connection, cursor, statement, parameters, context, executemany):
        if (action != "adopt" and threading.current_thread().name.startswith("plan")
                and "FROM market_datasets" in statement and "FOR UPDATE" in statement):
            plan_at_lock.set()

    def after_sql(connection, cursor, statement, parameters, context, executemany):
        if "FOR UPDATE" not in statement:
            return
        if (threading.current_thread().name.startswith("confirmation")
                and "FROM market_datasets" in statement):
            confirmation_locked.set()
            assert plan_at_lock.wait(5)
        if (threading.current_thread().name.startswith("plan")
                and ("FROM instruments" in statement
                     or action == "adopt" and "FROM market_datasets" in statement)):
            plan_at_lock.set()

    def complete_plan():
        if action == "adopt":
            managed_dataset.adopt_legacy_once()
            return
        with factory.begin() as db:
            if action == "complete":
                plan = db.get(ChartHistoryPlan, instrument_id)
                chart_history_plan.advance_plan(db, plan, 125000)
            elif action in ("join", "reactivate"):
                managed_dataset.join(db, db.get(Instrument, instrument_id), 0, 125000)
            else:
                chart_history_plan.control_plan(db, instrument_id, action, 125000)

    event.listen(engine, "before_cursor_execute", before_sql)
    event.listen(engine, "after_cursor_execute", after_sql)
    try:
        with ThreadPoolExecutor(max_workers=1, thread_name_prefix="confirmation") as confirmation_pool:
            confirmed = confirmation_pool.submit(live.commit_confirmation, ownership, epoch,
                                                  candles(identity), now=125000)
            assert confirmation_locked.wait(5)
            with ThreadPoolExecutor(max_workers=1, thread_name_prefix="plan") as plan_pool:
                completed = plan_pool.submit(complete_plan)
                errors = []
                for pending in (completed, confirmed):
                    try:
                        pending.result(timeout=10)
                    except Exception as error:
                        errors.append(type(error).__name__)
                assert not errors, f"plan lifecycle or confirmation aborted: {errors}"
        with factory.begin() as db:
            expected = {"complete": "complete", "cancel": "cancelled", "resume": "pending",
                        "join": "pending", "reactivate": "pending"}
            plan = db.get(ChartHistoryPlan, instrument_id)
            if action == "adopt":
                assert plan is None
            else:
                assert plan.status == expected[action]
                assert plan.realtime_enabled
            assert db.get(PricingOwner, ownership[0]).epoch == epoch
        if action == "adopt":
            managed_dataset.adopt_legacy_once()
            with factory.begin() as db:
                assert db.get(ChartHistoryPlan, instrument_id).status == "complete"
    finally:
        event.remove(engine, "before_cursor_execute", before_sql)
        event.remove(engine, "after_cursor_execute", after_sql)


def test_planner_rechecks_a_plan_cancelled_since_it_was_loaded(provider_pg):
    factory, _ = provider_pg
    with factory.begin() as db:
        instrument_id = register(db).id
        db.add(ChartHistoryPlan(instrument_id=instrument_id, target_start=0,
            target_end=120000, cursor=120000, status="pending", realtime_enabled=True))

    with factory.begin() as planner:
        stale_plan = planner.get(ChartHistoryPlan, instrument_id)
        with factory.begin() as user:
            chart_history_plan.control_plan(user, instrument_id, "cancel", 125000)
        assert not chart_history_plan.advance_plan(planner, stale_plan, 125000)
    with factory.begin() as db:
        assert db.get(ChartHistoryPlan, instrument_id).status == "cancelled"


@pytest.mark.parametrize("action", ["join", "control"])
def test_plan_writer_reloads_a_preloaded_approved_range(provider_pg, action):
    factory, _ = provider_pg
    with factory.begin() as db:
        instrument_id = register(db).id
        set_enabled(db, instrument_id, True, now=125000)
        db.add(ChartHistoryPlan(instrument_id=instrument_id, target_start=60000,
            target_end=120000, cursor=120000, status="pending", realtime_enabled=True))

    with factory.begin() as stale:
        preloaded = stale.get(ChartHistoryPlan, instrument_id)
        with factory.begin() as user:
            plan = managed_dataset.join(user, user.get(Instrument, instrument_id), 0, 125000)
            chart_history_plan.control_plan(user, instrument_id, "cancel", 125000)
            plan.realtime_enabled = False
        if action == "join":
            result = managed_dataset.join(stale, stale.get(Instrument, instrument_id), 60000, 185000)
            assert result.status == "pending" and not result.realtime_enabled
        else:
            result = chart_history_plan.control_plan(stale, instrument_id, "resume", 185000)
        assert result is preloaded
        assert (result.target_start, result.target_end) == (0, 120000)
    with factory.begin() as db:
        assert db.get(ChartHistoryPlan, instrument_id).target_start == 0


@pytest.mark.parametrize("action", ["advance", "control", "join"])
def test_plan_writer_preserves_unflushed_approved_range(provider_pg, action):
    factory, _ = provider_pg
    with factory.begin() as db:
        instrument_id = register(db).id
        db.add(ChartHistoryPlan(instrument_id=instrument_id, target_start=60000,
            target_end=120000, cursor=120000, status="pending", realtime_enabled=True))
    with factory.begin() as db:
        plan = db.get(ChartHistoryPlan, instrument_id)
        plan.target_start = 0
        if action == "advance":
            chart_history_plan.advance_plan(db, plan, 125000)
        elif action == "control":
            chart_history_plan.control_plan(db, instrument_id, "cancel", 125000)
        else:
            managed_dataset.join(db, db.get(Instrument, instrument_id), 60000, 125000)
        assert plan.target_start == 0
    with factory.begin() as db:
        assert db.get(ChartHistoryPlan, instrument_id).target_start == 0


@pytest.mark.parametrize("locked_row", ["dataset", "instrument"])
def test_adoption_skips_busy_dataset_or_instrument_then_retries(provider_pg, locked_row):
    factory, _ = provider_pg
    with factory.begin() as db:
        inst = register(db)
        instrument_id = inst.id
        ingest(db, inst, batch().ingestion_payload())

    blocker = factory()
    try:
        if locked_row == "dataset":
            blocker.scalar(select(MarketDataset).where(MarketDataset.instrument_id == instrument_id)
                           .with_for_update())
        else:
            blocker.scalar(select(Instrument).where(Instrument.id == instrument_id).with_for_update())
        with ThreadPoolExecutor(max_workers=1) as pool:
            adopted = pool.submit(managed_dataset.adopt_legacy_once)
            try:
                adopted.result(timeout=5)
                assert blocker.get(ChartHistoryPlan, instrument_id) is None
            finally:
                blocker.rollback()
    finally:
        blocker.close()
    managed_dataset.adopt_legacy_once()
    with factory.begin() as db:
        plan = db.get(ChartHistoryPlan, instrument_id)
        assert plan.status == "complete" and not plan.realtime_enabled
        assert (plan.target_start, plan.target_end) == (0, 120000)
