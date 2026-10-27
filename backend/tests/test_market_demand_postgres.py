"""Demand leases at their real PostgreSQL and chart transaction boundaries."""

import os
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from alerts import chart_query as chart_api
from alerts import market_data
from alerts.history_retention import reclaim
from alerts.storage import CompositeRevision, Instrument, MarketDataset, MarketDemand
from sqlalchemy import event, func, select
from sqlalchemy.exc import OperationalError
from test_composite_chart import populated
from test_history_retention import prepared
from test_market_contracts import identity
from test_market_datasets import register
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg

pytestmark = pytest.mark.skipif(
    not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated Ubuntu PostgreSQL"
)


def synchronize_first_demand_statement(engine):
    # Legacy read-then-insert rendezvous after both reads return empty. Atomic
    # implementations rendezvous before either INSERT; no SQL response is faked.
    barrier = threading.Barrier(2)
    arrived = threading.local()

    def meet(statement):
        if (not threading.current_thread().name.startswith("demand-reader")
                or "market_data_demand" not in statement or getattr(arrived, "done", False)):
            return
        arrived.done = True
        barrier.wait(timeout=5)

    def before(conn, cursor, sql, params, context, many):
        if sql.startswith("INSERT INTO market_data_demand"):
            meet(sql)

    def after(conn, cursor, sql, params, context, many):
        if sql.startswith("SELECT") and "FROM market_data_demand" in sql:
            meet(sql)

    event.listen(engine, "before_cursor_execute", before)
    event.listen(engine, "after_cursor_execute", after)
    return before, after


@pytest.mark.parametrize("path", ["renew", "data_sync"])
def test_same_key_first_registration_commits_both_requests(provider_pg, monkeypatch, path):
    factory, engine = provider_pg
    if path == "data_sync":
        composite_id, revision_id, _ = populated(factory, monkeypatch)
        with factory.begin() as db:
            from alerts.storage import MarketComposite
            instrument_id = db.get(MarketComposite, composite_id).instrument_id
        body = chart_api.DataQuery(instrument="MWC:" + composite_id, timeframe="M1",
            limit=3, client="parallel-reader", composite_revision_id=revision_id)
        def read():
            return chart_api.data_sync(body)
    else:
        revision_id = None
        with factory.begin() as db:
            inst = Instrument(id="legacy-demand", label="EURUSD", source="oanda",
                symbol="EUR_USD", basis="bid", calendar="ny17", precision=5,
                calendar_profile={}, enabled=True)
            db.add(inst)
            db.flush()
            instrument_id = inst.id

        def read():
            with factory.begin() as db:
                market_data.renew_demand(db, "parallel-reader", db.get(Instrument, instrument_id))

    hooks = synchronize_first_demand_statement(engine)
    try:
        with ThreadPoolExecutor(max_workers=2, thread_name_prefix="demand-reader") as pool:
            results = [pool.submit(read) for _ in range(2)]
            for result in results:
                response = result.result(timeout=10)
                if path == "data_sync":
                    assert response["bars"] and response["revision_id"] == revision_id
        with factory.begin() as db:
            assert db.scalar(select(func.count()).select_from(MarketDemand)) == 1
            lease = db.get(MarketDemand, market_data.demand_id("parallel-reader", instrument_id,
                composite_revision_id=revision_id))
            assert lease.instrument_id == instrument_id
            assert lease.composite_revision_id == revision_id
    finally:
        event.remove(engine, "before_cursor_execute", hooks[0])
        event.remove(engine, "after_cursor_execute", hooks[1])


def test_concurrent_late_older_renewal_cannot_shorten_lease(provider_pg, monkeypatch):
    factory, _ = provider_pg
    with factory.begin() as db:
        inst = register(db)
        from alerts.realtime_switch import set_enabled
        set_enabled(db, inst.id, True, now=0)
        instrument_id = inst.id
        market_data.renew_demand(db, "clock", inst)
    monkeypatch.setattr(market_data, "now_ms", lambda: (
        2_000_000_200_000 if threading.current_thread().name.startswith("newer")
        else 2_000_000_100_000))
    held, older_started = threading.Event(), threading.Event()

    def newer():
        with factory.begin() as db:
            market_data.renew_demand(db, "clock", db.get(Instrument, instrument_id))
            held.set()
            assert older_started.wait(5)

    def older():
        assert held.wait(5)
        with factory.begin() as db:
            inst = db.get(Instrument, instrument_id)
            older_started.set()
            market_data.renew_demand(db, "clock", inst)

    with ThreadPoolExecutor(max_workers=1, thread_name_prefix="newer") as new_pool:
        new = new_pool.submit(newer)
        with ThreadPoolExecutor(max_workers=1, thread_name_prefix="older") as old_pool:
            old = old_pool.submit(older)
            new.result(timeout=10)
            old.result(timeout=10)
    with factory.begin() as db:
        lease = db.get(MarketDemand, market_data.demand_id("clock", instrument_id))
        assert lease.updated_at == 2_000_000_200_000
        assert lease.expires == 2_000_000_320_000


def test_demand_core_write_fences_reclamation_and_rolls_back(provider_pg):
    factory, _ = provider_pg
    _, instrument_id = prepared(factory)
    with factory.begin() as db:
        from alerts.realtime_switch import set_enabled
        set_enabled(db, instrument_id, True, now=0)
    with factory() as writer:
        writer.begin()
        market_data.renew_demand(writer, "fenced", writer.get(Instrument, instrument_id))
        writer.flush()
        with factory.begin() as collecting:
            with pytest.raises(OperationalError) as blocked:
                collecting.scalar(select(MarketDataset.id).where(MarketDataset.id == identity().key)
                    .with_for_update(nowait=True))
            assert blocked.value.orig.sqlstate == "55P03"
        writer.rollback()
    with factory.begin() as db:
        assert db.scalar(select(MarketDemand)) is None
        market_data.renew_demand(db, "fenced", db.get(Instrument, instrument_id))
    with factory.begin() as db:
        with pytest.raises(ValueError, match="引用"):
            reclaim(db, identity().key, "demand-active")


def test_conflicting_identity_is_rejected_instead_of_silently_renewed(provider_pg, monkeypatch):
    factory, _ = provider_pg
    monkeypatch.setattr(market_data, "demand_id", lambda *args, **kwargs: "same-id")
    with factory.begin() as db:
        first = register(db)
        second = register(db, identity(channel="node"))
        from alerts.realtime_switch import set_enabled
        set_enabled(db, first.id, True, now=0)
        set_enabled(db, second.id, True, now=0)
        first_id, second_id = first.id, second.id
        market_data.renew_demand(db, "first", first)
    with factory.begin() as db:
        with pytest.raises(ValueError, match="身份"):
            market_data.renew_demand(db, "second", db.get(Instrument, second_id))
        assert db.get(MarketDemand, "same-id").instrument_id == first_id


def test_revision_leases_are_distinct_and_invalid_read_creates_no_lease(provider_pg, monkeypatch):
    factory, _ = provider_pg
    composite_id, revision_id, _ = populated(factory, monkeypatch)
    from alerts.storage import MarketComposite
    with factory.begin() as db:
        revision = db.get(CompositeRevision, revision_id)
        second = CompositeRevision(composite_id=composite_id,
            history_version_id=revision.history_version_id, mapping_id=revision.mapping_id,
            seam=revision.seam, rules=revision.rules, request_id="second")
        db.add(second)
        db.flush()
        inst = db.get(Instrument, db.get(MarketComposite, composite_id).instrument_id)
        market_data.renew_demand(db, "reader", inst, composite_revision_id=revision_id)
        market_data.renew_demand(db, "reader", inst, composite_revision_id=second.id)
        with pytest.raises(ValueError, match="修订"):
            market_data.renew_demand(db, "invalid", inst, composite_revision_id="missing")
    with factory.begin() as db:
        assert db.scalar(select(func.count()).select_from(MarketDemand)) == 2
        disabled = register(db, identity(channel="node"))
        assert not disabled.enabled
        market_data.renew_demand(db, "unauthorized", disabled)
    with factory.begin() as db:
        assert db.scalar(select(func.count()).select_from(MarketDemand)) == 2
