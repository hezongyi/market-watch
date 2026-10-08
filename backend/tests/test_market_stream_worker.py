"""Shared worker uses authoritative readers, and does no idle reaggregation."""

from alerts import market_stream as stream
from alerts.chart_api import DataQuery
from alerts.market_stream_api import Subscription, resolve
from alerts.market_stream_worker import Calculator
from alerts.storage import MarketStreamTask
from test_composite_chart import populated
from test_fixed_series_revisions import correction
from test_market_stream import session


def test_shared_worker_detects_history_only_correction_and_consumers_have_distinct_windows(database, monkeypatch):
    composite, revision, seam = populated(database, monkeypatch)
    owner = session(database)
    query = DataQuery(instrument=composite, series_kind="composite", timeframe="M1", provisional=False)
    identity, serialized = resolve(Subscription(client="page", listener="chart", generation=1,
        kind="bars", query=query))
    first = stream.register(owner, "page", "chart", 1, identity, serialized,
                            {"loaded_after": seam, "loaded_before": seam + 540000})
    stream.register(owner, "other", "chart", 1, identity, serialized,
                    {"loaded_after": seam + 300000, "loaded_before": seam + 540000})
    calculator = Calculator()
    work = stream.claim()
    payload, delay = calculator.build(work)
    assert payload["bars"] and payload["resolved_revision_id"] == revision
    stream.commit(work, payload, delay_ms=0)
    a, b = {}, {}
    assert stream.events(owner, "page", a)[0]["type"] == "bars"
    assert stream.events(owner, "other", b)[0]["type"] == "bars"
    work = stream.claim()
    assert calculator.build(work)[0] is None
    stream.commit(work, None, delay_ms=0)
    assert calculator.computations == 1
    with database.begin() as db:
        correction(db, revision, seam + 60000, 200001000, "1.115")
    work = stream.claim()
    payload, delay = calculator.build(work)
    stream.commit(work, payload, delay_ms=0)
    assert stream.events(owner, "page", a)[0]["type"] == "reset"
    assert stream.events(owner, "other", b)[0]["type"] == "bars"
    assert calculator.computations == 2
    with database.begin() as db:
        assert db.get(MarketStreamTask, first["task_id"]).sequence == 2


def test_current_bucket_reader_uses_delta_and_replaces_expired_stream_observation(database, monkeypatch):
    from alerts import live_pricing as live
    from alerts.composite_realtime import CurrentBuckets
    from alerts.composite_series import read_window
    from alerts.market_contracts import DatasetIdentity, QuoteEvent
    from alerts.storage import CompositeRevision, MarketDataset, PricingOwner, RealtimeMapping

    composite, revision_id, seam = populated(database, monkeypatch)
    with database.begin() as db:
        revision = db.get(CompositeRevision, revision_id)
        target = db.get(MarketDataset, db.get(RealtimeMapping, revision.mapping_id).target_dataset_id)
        ident = DatasetIdentity.model_validate(target.identity)
    owner = live.claim(live.settings.oanda_account_id, now=200010000)
    epoch = live.begin_connection(owner, {"EUR_USD": ident}, now=200010000)
    live.publish_event(owner, epoch, QuoteEvent(identity=ident, bid="1.10", ask="1.11",
        source_time=200005000, received_at=200006000, tradeable=True, connection_epoch=epoch, sequence=1),
        {"EUR_USD": ident}, now=200010000)
    from alerts.composite_series import period
    left, right = period(200005000, "W1", revision.rules["aggregation_calendar"])
    cache = CurrentBuckets()

    def compare():
        with database.begin() as db:
            plain = read_window(db, composite, "W1", left, right, provisional=True, now=200010000)
            cached = read_window(db, composite, "W1", left, right, provisional=True,
                                 now=200010000, realtime=cache)
            assert cached == plain

    compare()
    compare()
    assert cache.builds == 1
    with database.begin() as db:
        correction(db, revision_id, seam + 60000, 200001000, "1.115")
    compare()
    assert cache.builds == 1 and cache.delta_reads == 1
    with database.begin() as db:
        db.get(PricingOwner, owner[0]).expires = 0
    compare()
    assert cache.builds == 1


def test_shared_page_cache_matches_authoritative_high_period_overlay(database, monkeypatch):
    from alerts import live_pricing as live
    from alerts.composite_chart import chart_page
    from alerts.composite_realtime import CurrentBuckets
    from alerts.market_contracts import DatasetIdentity, QuoteEvent
    from alerts.storage import CompositeRevision, MarketDataset, PricingOwner, RealtimeMapping

    composite, revision_id, seam = populated(database, monkeypatch)
    with database.begin() as db:
        revision = db.get(CompositeRevision, revision_id)
        target = db.get(MarketDataset, db.get(RealtimeMapping, revision.mapping_id).target_dataset_id)
        ident = DatasetIdentity.model_validate(target.identity)
    owner = live.claim(live.settings.oanda_account_id, now=200010000)
    epoch = live.begin_connection(owner, {"EUR_USD": ident}, now=200010000)
    cache = CurrentBuckets()
    for sequence in range(1, 4):
        live.publish_event(owner, epoch, QuoteEvent(identity=ident, bid=str(1.10 + sequence / 1000), ask="1.12",
            source_time=200005000 + sequence, received_at=200006000 + sequence, tradeable=True,
            connection_epoch=epoch, sequence=sequence), {"EUR_USD": ident}, now=200010000)
        for frame in ("M1", "W1", "MN"):
            with database.begin() as db:
                plain = chart_page(db, composite, frame, count=20, provisional=True, now=200010000)
                cached = chart_page(db, composite, frame, count=20, provisional=True, now=200010000, realtime=cache)
                assert cached["bars"] == plain["bars"]
    assert cache.builds == 3
    with database.begin() as db:
        correction(db, revision_id, seam + 60000, 200001000, "1.115")
        db.get(PricingOwner, owner[0]).expires = 0
    for frame in ("M1", "W1", "MN"):
        with database.begin() as db:
            plain = chart_page(db, composite, frame, count=20, provisional=True, now=200010000)
            cached = chart_page(db, composite, frame, count=20, provisional=True, now=200010000, realtime=cache)
            assert cached["bars"] == plain["bars"]


def test_canceling_last_browser_demand_preserves_other_internal_owners(database, monkeypatch):
    from alerts.storage import MarketDemand
    from sqlalchemy import select

    composite, revision, seam = populated(database, monkeypatch)
    owner = session(database)
    query = DataQuery(instrument=composite, series_kind="composite", timeframe="M1", provisional=False)
    identity, serialized = resolve(Subscription(client="page", listener="chart", generation=1,
        kind="bars", query=query))
    stream.register(owner, "page", "chart", 1, identity, serialized, {})
    work = stream.claim()
    calculator = Calculator()
    payload, delay = calculator.build(work)
    stream.commit(work, payload, delay_ms=0)
    with database.begin() as db:
        demand = db.scalar(select(MarketDemand))
        assert demand
        db.add(MarketDemand(id="independent-alert-demand", instrument_id=demand.instrument_id,
            composite_revision_id=demand.composite_revision_id, expires=stream.now_ms()+100000,
            updated_at=stream.now_ms()))
    stream.cancel(owner, "page", "chart", 1)
    assert stream.claim() is None
    with database.begin() as db:
        assert [row.id for row in db.scalars(select(MarketDemand))] == ["independent-alert-demand"]


def test_managed_preparation_waits_for_native_dataset_readiness(database):
    from alerts.storage import ChartPublication

    owner = session(database)
    query = DataQuery(instrument="BTCUSDT", series_kind="managed", timeframe="M1", published=True)
    identity, serialized = resolve(Subscription(client="page", listener="chart", generation=1,
        kind="bars", query=query))
    stream.register(owner, "page", "chart", 1, identity, serialized, {"history_accepted": False})
    with database.begin() as db:
        db.add(ChartPublication(instrument_id="BTCUSDT", timeframe="M1", start=60000,
            end=120000, complete_count=1, initialized=False, revision=1))
    cursors = {}
    stream.commit(stream.claim(), {"type": "bars", "bars": [{"start": 60000}]}, delay_ms=0)
    assert stream.events(owner, "page", cursors)[0]["type"] == "status", \
        "a partial publication must not restart a first screen that still cannot load"
    with database.begin() as db:
        db.get(ChartPublication, ("BTCUSDT", "M1")).initialized = True
    stream.commit(stream.claim(), {"type": "bars", "bars": [{"start": 60000}],
        "publication_revision": 2}, delay_ms=0)
    event = stream.events(owner, "page", cursors)[0]
    assert event["type"] == "reset" and event["reason"] == "initial_history_ready"


def test_canceled_inflight_computation_does_not_leave_a_browser_demand(database, monkeypatch):
    from alerts.storage import MarketDemand
    from sqlalchemy import select

    composite, revision, seam = populated(database, monkeypatch)
    owner = session(database)
    query = DataQuery(instrument=composite, series_kind="composite", timeframe="M1", provisional=False)
    identity, serialized = resolve(Subscription(client="page", listener="chart", generation=1,
        kind="bars", query=query))
    stream.register(owner, "page", "chart", 1, identity, serialized, {})
    work = stream.claim()
    stream.cancel(owner, "page", "chart", 1)
    calculator = Calculator()
    payload, delay = calculator.build(work)
    stream.commit(work, payload, delay_ms=0)
    with database.begin() as db:
        assert db.scalar(select(MarketDemand)) is None, \
            "late worker demand must be retired when its final consumer was canceled"
    stream.register(owner, "page", "chart", 2, identity, serialized, {})
    work = stream.claim()
    payload, delay = calculator.build(work)
    stream.commit(work, payload, delay_ms=0)
    with database.begin() as db:
        assert db.scalar(select(MarketDemand)) is not None, \
            "a renewed consumer must restore demand immediately, even inside the old renewal interval"
