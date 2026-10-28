"""Quote-only tasks preserve source cadence, fixed input and owner state."""

from alerts import market_stream as stream
from alerts.chart_query import DataQuery
from alerts.market_stream_api import Subscription, resolve
from alerts.market_stream_worker import Calculator
from alerts.storage import MarketDemand, MarketStreamTask
from sqlalchemy import func, select
from test_composite_chart import populated
from test_composite_quotes import quote_state
from test_fixed_series_revisions import correction
from test_market_stream import session


def subscribe(factory, composite, *, revision=None, value=None, client="page"):
    owner = session(factory)
    query = DataQuery(instrument=composite, series_kind="composite", timeframe="M1",
                      composite_revision_id=revision, input_revision=value)
    identity, serialized = resolve(Subscription(client=client, listener="watchlist", generation=1,
        kind="quotes", query=query))
    stream.register(owner, client, "watchlist", 1, identity, serialized, {})
    return owner, identity, serialized


def publish(calculator):
    work = stream.claim()
    payload, _ = calculator.build(work)
    stream.commit(work, payload, delay_ms=0)
    return payload


def test_quote_only_clients_share_work_and_report_expiry_without_new_price(database, monkeypatch):
    from alerts import composite_quotes, market_stream_worker

    composite, revision, seam = populated(database, monkeypatch)
    clock = [200010000]
    quote_state(database, revision, clock[0])
    monkeypatch.setattr(composite_quotes, "now_ms", lambda: clock[0])
    monkeypatch.setattr(market_stream_worker, "now_ms", lambda: clock[0])
    owner, identity, serialized = subscribe(database, composite)
    stream.register(owner, "other", "watchlist", 1, identity, serialized, {})
    calculator, a, b = Calculator(), {}, {}
    publish(calculator)
    for client, cursor in (("page", a), ("other", b)):
        first = stream.events(owner, client, cursor)[0]
        assert first["type"] == "quotes" and first["quotes"][0]["v"]["quote_ready"]
    assert calculator.computations == 1
    assert publish(calculator) is None, "unchanged quote input does not repeat snapshot computation"
    clock[0] += 15001
    publish(calculator)
    for client, cursor in (("page", a), ("other", b)):
        stale = stream.events(owner, client, cursor)[0]["quotes"][0]
        assert not stale["v"]["quote_ready"]
        assert stale["v"]["price_type"] == "confirmed_m1_close"
    with database.begin() as db:
        assert db.scalar(select(func.count()).select_from(MarketStreamTask)) == 1
        demand = db.scalar(select(MarketDemand))
        assert demand and demand.composite_revision_id == revision
    stream.cancel(owner, "page", "watchlist", 1)
    with database.begin() as db:
        assert db.scalar(select(MarketDemand)) is not None
    stream.cancel(owner, "other", "watchlist", 1)
    with database.begin() as db:
        assert db.scalar(select(MarketDemand)) is None


def test_fixed_quote_input_remains_on_accepted_confirmation(database, monkeypatch):
    from alerts import composite_quotes, market_stream_worker

    composite, revision, seam = populated(database, monkeypatch)
    quote_state(database, revision, 200010000)
    monkeypatch.setattr(composite_quotes, "now_ms", lambda: 200010000)
    monkeypatch.setattr(market_stream_worker, "now_ms", lambda: 200010000)
    owner, _, _ = subscribe(database, composite, revision=revision, value=1)
    calculator, cursor = Calculator(), {}
    publish(calculator)
    fixed = stream.events(owner, "page", cursor)[0]["quotes"][0]
    assert fixed["v"]["price_type"] == "confirmed_m1_close", "fixed input must not adopt live bid"
    with database.begin() as db:
        correction(db, revision, seam + 540000, 201000000, "1.119")
    publish(calculator)
    with database.begin() as db:
        payload = db.scalar(select(MarketStreamTask)).payload
    current = payload["quotes"][0]
    assert current["v"]["lp"] == fixed["v"]["lp"]
    assert current["snapshot"]["input_revision"] == 1


def test_follow_active_switch_releases_only_previous_task_revision_demand(database, monkeypatch):
    from alerts.composite_revisions import activate, create
    from test_composite_revisions import prepared, request

    composite, old, body = request(database, monkeypatch)
    owner, identity, serialized = subscribe(database, composite)
    calculator = Calculator()
    publish(calculator)
    cursor = {}
    first = stream.events(owner, "page", cursor)[0]
    assert first["type"] == "quotes"
    stream.register(owner, "page", "watchlist", 1, identity, serialized,
                    {"sequence": first["sequence"], "binding": old})
    cursor = {}
    with database.begin() as db:
        demand = db.scalar(select(MarketDemand))
        assert demand.composite_revision_id == old
        db.add(MarketDemand(id="independent-old-alert", instrument_id=demand.instrument_id,
            composite_revision_id=old, expires=stream.now_ms()+100000, updated_at=stream.now_ms()))
        new = create(db, composite, body).id
    prepared(database, new)
    with database.begin() as db:
        activate(db, composite, new, {"request_id":"stream-switch", "expected_revision_id":old})
    publish(calculator)
    switched = stream.events(owner, "page", cursor)[0]
    assert switched["type"] == "reset" and switched["reason"] == "binding_changed", \
        "follow-active quotes must rebind before delivering another revision"
    query = DataQuery(instrument=composite, series_kind="composite", timeframe="M1")
    identity, serialized = resolve(Subscription(client="page", listener="watchlist", generation=2,
        kind="quotes", query=query))
    stream.register(owner, "page", "watchlist", 2, identity, serialized, {})
    restored = stream.events(owner, "page", {})[0]
    assert restored["type"] == "quotes" and restored["quotes"][0]["snapshot"]["revision_id"] == new
    with database.begin() as db:
        browser = list(db.scalars(select(MarketDemand).where(MarketDemand.id != "independent-old-alert")))
        assert [row.composite_revision_id for row in browser] == [new], \
            "follow-active task must retire its old revision demand on switch"
        assert db.get(MarketDemand, "independent-old-alert") is not None
    stream.cancel(owner, "page", "watchlist", 2)
    with database.begin() as db:
        assert [row.id for row in db.scalars(select(MarketDemand))] == ["independent-old-alert"]


def test_managed_quote_cancellation_releases_only_task_demand(database):
    owner = session(database)
    query = DataQuery(instrument="BTCUSDT", timeframe="M1")
    identity, serialized = resolve(Subscription(client="page", listener="watchlist", generation=1,
        kind="quotes", query=query))
    stream.register(owner, "page", "watchlist", 1, identity, serialized, {})
    calculator = Calculator()
    publish(calculator)
    with database.begin() as db:
        demand = db.scalar(select(MarketDemand))
        assert demand and demand.composite_revision_id is None
        db.add(MarketDemand(id="managed-alert", instrument_id="BTCUSDT",
            expires=stream.now_ms()+100000, updated_at=stream.now_ms()))
    stream.cancel(owner, "page", "watchlist", 1)
    with database.begin() as db:
        assert [row.id for row in db.scalars(select(MarketDemand))] == ["managed-alert"]


def test_managed_quotes_with_history_plan_deliver_confirmed_updates(database, monkeypatch):
    from decimal import Decimal

    from alerts import market_stream_worker
    from alerts.storage import Bar, ChartHistoryPlan, now_ms

    owner = session(database)
    start = now_ms() // 60000 * 60000 - 60000
    monkeypatch.setattr(market_stream_worker, "now_ms", lambda: start + 30000)
    with database.begin() as db:
        db.add(ChartHistoryPlan(instrument_id="BTCUSDT", target_start=start,
            target_end=start+60000, cursor=start, status="ready"))
        db.add(Bar(instrument_id="BTCUSDT",timeframe="M1",start=start,end=start+60000,
            open=100,high=110,low=90,close=101,complete=True,revision=1))
    query = DataQuery(instrument="BTCUSDT",timeframe="M1",published=True)
    identity, serialized = resolve(Subscription(client="page",listener="watchlist",generation=1,
        kind="quotes",query=query))
    stream.register(owner,"page","watchlist",1,identity,serialized,{})
    calculator, cursor = Calculator(), {}
    publish(calculator)
    assert stream.events(owner,"page",cursor)[0]["quotes"][0]["v"]["lp"] == 101
    with database.begin() as db:
        row = db.scalar(select(Bar).where(Bar.instrument_id == "BTCUSDT",Bar.start == start))
        row.close, row.revision = Decimal("102"), 2
    publish(calculator)
    assert stream.events(owner,"page",cursor)[0]["quotes"][0]["v"]["lp"] == 102
    assert publish(calculator) is None, "unchanged confirmed input is not repeatedly calculated"


def test_quote_only_provider_task_keeps_supplier_cadence_without_history_interest(database, monkeypatch):
    from alerts import provider_chart
    from alerts.provider_capabilities import poll_seconds
    from alerts.storage import ProviderDataset, ProviderInterest
    from test_provider_cache import META

    meta = {**META, "name": "Test EURUSD"}
    calls = []
    monkeypatch.setattr(provider_chart, "metadata", lambda instrument, **kwargs: meta)
    monkeypatch.setattr(provider_chart, "quote_page", lambda meta: calls.append(meta["id"]) or
        {"bars": [{"start":60000, "end":120000, "close":"1.1"}]})
    monkeypatch.setattr(provider_chart, "quote_previous_close", lambda *_: None)
    owner = session(database)
    query = DataQuery(instrument=META["id"], series_kind="provider", timeframe="M1")
    identity, serialized = resolve(Subscription(client="page", listener="watchlist", generation=1,
        kind="quotes", query=query))
    stream.register(owner, "page", "watchlist", 1, identity, serialized, {})
    stream.register(owner, "other", "watchlist", 1, identity, serialized, {})
    calculator = Calculator()
    work = stream.claim()
    payload, delay = calculator.build(work)
    assert delay == poll_seconds(meta["source"]) * 1000
    stream.commit(work, payload, delay_ms=delay)
    assert stream.claim() is None, "another consumer must not accelerate supplier collection"
    assert calls == [META["id"]]
    for client in ("page", "other"):
        assert stream.events(owner, client, {})[0]["quotes"][0]["v"]["lp"] == 1.1
    with database.begin() as db:
        assert db.scalar(select(ProviderInterest)) is None
        assert db.scalar(select(ProviderDataset)) is None
        assert db.scalar(select(MarketDemand)) is None


def test_replacing_last_quote_consumer_retires_previous_series_demand(database, monkeypatch):
    composite, revision, _ = populated(database, monkeypatch)
    owner, _, _ = subscribe(database, composite)
    calculator = Calculator()
    publish(calculator)
    with database.begin() as db:
        old = db.scalar(select(MarketDemand))
        assert old.composite_revision_id == revision
    query = DataQuery(instrument="BTCUSDT", timeframe="M1")
    identity, serialized = resolve(Subscription(client="page", listener="watchlist", generation=2,
        kind="quotes", query=query))
    stream.register(owner, "page", "watchlist", 2, identity, serialized, {})
    with database.begin() as db:
        assert db.scalar(select(MarketDemand)) is None, \
            "replacing the final consumer must release the previous computation's browser demand"


def test_replacement_retains_demand_for_another_page_and_late_cancel_is_fenced(database, monkeypatch):
    composite, revision, _ = populated(database, monkeypatch)
    owner, identity, serialized = subscribe(database, composite)
    stream.register(owner, "other", "watchlist", 1, identity, serialized, {})
    calculator = Calculator()
    publish(calculator)
    query = DataQuery(instrument="BTCUSDT", timeframe="M1")
    identity, serialized = resolve(Subscription(client="page", listener="watchlist", generation=2,
        kind="quotes", query=query))
    stream.register(owner, "page", "watchlist", 2, identity, serialized, {})
    stream.cancel(owner, "page", "watchlist", 1)
    with database.begin() as db:
        assert db.scalar(select(MarketDemand)).composite_revision_id == revision
    stream.cancel(owner, "other", "watchlist", 1)
    with database.begin() as db:
        assert db.scalar(select(MarketDemand)) is None


def test_cancel_after_active_switch_before_worker_runs_retires_previous_demand(database, monkeypatch):
    from alerts.composite_revisions import activate, create
    from test_composite_revisions import prepared, request

    composite, old, body = request(database, monkeypatch)
    owner, _, _ = subscribe(database, composite)
    publish(Calculator())
    with database.begin() as db:
        new = create(db, composite, body).id
    prepared(database, new)
    with database.begin() as db:
        activate(db, composite, new, {"request_id":"stream-switch-cancel", "expected_revision_id":old})
    stream.cancel(owner, "page", "watchlist", 1)
    with database.begin() as db:
        assert db.scalar(select(MarketDemand)) is None, \
            "cancellation must retire actual task demands, even when the active binding already changed"


def test_explicit_quote_revision_does_not_follow_active_switch(database, monkeypatch):
    from alerts.composite_revisions import activate, create
    from test_composite_revisions import prepared, request

    composite, old, body = request(database, monkeypatch)
    owner, _, _ = subscribe(database, composite, revision=old, value=1)
    calculator, cursor = Calculator(), {}
    publish(calculator)
    initial = stream.events(owner, "page", cursor)[0]["quotes"][0]
    with database.begin() as db:
        new = create(db, composite, body).id
    prepared(database, new)
    with database.begin() as db:
        activate(db, composite, new, {"request_id":"pinned-quote-switch", "expected_revision_id":old})
    publish(calculator)
    assert stream.events(owner, "page", cursor) == []
    with database.begin() as db:
        fixed = db.scalar(select(MarketStreamTask)).payload["quotes"][0]
        assert fixed["snapshot"]["revision_id"] == old
        assert fixed["v"]["lp"] == initial["v"]["lp"]
        assert db.scalar(select(MarketDemand)).composite_revision_id == old
