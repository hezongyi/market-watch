"""Shared worker uses authoritative readers, and does no idle reaggregation."""

from alerts import market_stream as stream
from alerts.chart_api import DataQuery
from alerts.market_stream_api import Subscription, resolve
from alerts.market_stream_worker import Calculator
from alerts.storage import MarketStreamTask
from test_composite_chart import populated
from test_fixed_series_revisions import correction
from test_market_stream import session


def test_provider_swing_worker_uses_bar_revision_and_ignores_future_rows(database, monkeypatch):
    from alerts import market_stream_worker as worker
    from alerts import provider_cache as cache
    from alerts import provider_chart as upstream
    from test_provider_cache import META, page, seed

    key = seed(META, "M5", 10000, page(1000, 10000))
    # A cache may already contain rows beyond the worker's observation clock.
    seed(META, "M5", 15000, page(10000, 15000))
    monkeypatch.setattr(upstream, "metadata", lambda *_a, **_k: META)
    monkeypatch.setattr(worker, "now_ms", lambda: 10000)
    owner = session(database)
    query = DataQuery(instrument=META["id"], series_kind="provider", timeframe="M5",
                      indicators=[{"name": "SWING_SR_V1"}])
    identity, serialized = resolve(Subscription(client="page", listener="swing", generation=1,
                                               kind="bars", query=query))
    stream.register(owner, "page", "swing", 1, identity, serialized, {})
    payload, _ = Calculator().build(stream.claim())
    presentation = payload["indicators"][0]["presentation"]
    assert presentation["as_of_bar_time"] == payload["bars"][-1]["start"] == 10000
    assert presentation["history_revision"] == str(payload["cache_revision"])
    assert presentation["history_complete"] is True
    assert payload["cache_revision"] == cache.snapshot(key, 15000, 1)["cache_revision"]
    assert all(v["time"] <= 10000 for s in payload["indicators"][0]["series"] for v in s["values"])


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


def test_live_quote_arriving_during_chart_resolution_is_not_retracted(database, monkeypatch):
    from alerts import live_pricing as live
    from alerts import series_access
    from alerts.composite_realtime import CurrentBuckets
    from alerts.market_contracts import DatasetIdentity, QuoteEvent
    from alerts.storage import CompositeRevision, MarketDataset, RealtimeMapping

    composite, revision_id, _ = populated(database, monkeypatch)
    with database.begin() as db:
        revision = db.get(CompositeRevision, revision_id)
        target = db.get(MarketDataset, db.get(RealtimeMapping, revision.mapping_id).target_dataset_id)
        ident = DatasetIdentity.model_validate(target.identity)
    ownership = live.claim(live.settings.oanda_account_id, now=200010000)
    epoch = live.begin_connection(ownership, {"EUR_USD": ident}, now=200010000)
    live.publish_event(ownership, epoch, QuoteEvent(identity=ident, bid="1.10", ask="1.11",
        source_time=200011000, received_at=200011000, tradeable=True, connection_epoch=epoch, sequence=1),
        {"EUR_USD": ident}, now=200012000)
    clock = [200010000]
    monkeypatch.setattr(series_access, "now_ms", lambda: clock[0])
    original = series_access.metadata

    def resolved(*args, **kwargs):
        result = original(*args, **kwargs)
        clock[0] = 200012000
        return result

    monkeypatch.setattr(series_access, "metadata", resolved)
    for cache in (None, CurrentBuckets()):
        clock[0] = 200010000
        with database.begin() as db:
            page = series_access.chart_data(db, DataQuery(instrument=composite,
                series_kind="composite", timeframe="M1"), realtime=cache)
            assert page["bars"][-1]["start"] == 200011000 // 60000 * 60000
            assert not page["bars"][-1]["source_confirmed"], \
                "fresh quote read after metadata must use an observation clock captured after the source read"
    monkeypatch.setattr(series_access, "metadata", original)
    from alerts.storage import LiveState

    for cache in (None, CurrentBuckets()):
        clock[0] = 200010000
        with database.begin() as db:
            original_get = db.get

            def received(model, *args, **kwargs):
                row = original_get(model, *args, **kwargs)
                if model is LiveState:
                    clock[0] = 200012000
                return row

            monkeypatch.setattr(db, "get", received)
            page = series_access.chart_data(db, DataQuery(instrument=composite,
                series_kind="composite", timeframe="M1"), realtime=cache)
            assert page["bars"][-1]["start"] == 200011000 // 60000 * 60000, \
                "a receipt during the actual LiveState read must also precede the evaluation clock"
    clock[0] = 200010000
    with database.begin() as db:
        earlier = series_access.chart_data(db, DataQuery(instrument=composite,
            series_kind="composite", timeframe="M1"))
        assert all(bar["source_confirmed"] for bar in earlier["bars"]), \
            "a quote that is still in the future at the observation clock remains unavailable"


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


def test_indicator_initialization_is_shared_and_completion_requests_history_recovery(database, monkeypatch):
    from test_fixed_indicators import SPEC, drain, history

    version = history(database, monkeypatch, count=50)
    owner = session(database)
    query = DataQuery(instrument=version, series_kind="history", timeframe="M1", indicators=[SPEC])
    identity, serialized = resolve(Subscription(client="page", listener="chart", generation=1,
        kind="bars", query=query))
    for client in ("page", "other"):
        stream.register(owner, client, "chart", 1, identity, serialized, {"initial_indicator_pending": True})
    calculator = Calculator()
    work = stream.claim()
    payload, _ = calculator.build(work)
    stream.commit(work, payload, delay_ms=0)
    a, b = {}, {}
    assert stream.events(owner, "page", a)[0]["pending"]
    assert stream.events(owner, "other", b)[0]["pending"]
    drain(payload["indicator_progress"][0]["run_id"])
    work = stream.claim()
    payload, _ = calculator.build(work)
    stream.commit(work, payload, delay_ms=0)
    assert stream.events(owner, "page", a)[0]["type"] == "reset"
    assert stream.events(owner, "other", b)[0]["type"] == "reset"
    assert calculator.computations == 2
    with database.begin() as db:
        from alerts.storage import FixedIndicatorRun
        from sqlalchemy import func, select
        assert db.scalar(select(func.count()).select_from(FixedIndicatorRun)) == 1
    stream.register(owner, "page", "chart", 2, identity, serialized, {})
    event = stream.events(owner, "page", {})[0]
    assert event["type"] == "bars" and not event["pending"]
    assert event["indicators"][0]["series"][0]["values"][-1]["value"] is not None


def test_correction_to_previously_streamed_bar_requires_native_history_reset(database, monkeypatch):
    composite, revision, seam = populated(database, monkeypatch)
    owner = session(database)
    query = DataQuery(instrument=composite, series_kind="composite", timeframe="M1", provisional=False)
    identity, serialized = resolve(Subscription(client="page", listener="chart", generation=1,
        kind="bars", query=query))
    consumer = {"cursor": seam + 540000, "loaded_after": seam, "loaded_before": seam + 540000,
                "initial_input_revision": 1}
    stream.register(owner, "page", "chart", 1, identity, serialized, consumer)
    calculator, cursors = Calculator(), {}

    def publish():
        work = stream.claim()
        payload, _ = calculator.build(work)
        stream.commit(work, payload, delay_ms=0)
        return stream.events(owner, "page", cursors)[0]

    assert publish()["type"] == "bars"
    for offset in (600000, 660000):
        with database.begin() as db:
            correction(db, revision, seam + offset, 200001000 + offset)
        event = publish()
        assert event["bars"][-1]["start"] == seam + offset
    assert event.get("loaded_before") == seam + 660000, \
        "reconnecting clients need the accepted appended range credential"
    consumer.update({key: event[key] for key in ("loaded_before", "history_revision", "initial_input_revision")})
    consumer.update(cursor=seam + 660000, sequence=event["sequence"])
    stream.register(owner, "page", "chart", 1, identity, serialized, consumer)
    cursors = {}
    with database.begin() as db:
        correction(db, revision, seam + 600000, 201000000, "1.119")
    event = publish()
    assert event["type"] == "reset" and event["reason"] == "history_changed", \
        "the loaded native range includes bars appended by SSE, not only the first HTTP response"


def test_historical_window_credentials_do_not_expand_to_realtime_tail(database, monkeypatch):
    composite, revision, seam = populated(database, monkeypatch)
    owner = session(database)
    query = DataQuery(instrument=composite, series_kind="composite", timeframe="M1", provisional=False)
    identity, serialized = resolve(Subscription(client="page", listener="chart", generation=1,
        kind="bars", query=query))
    stream.register(owner, "page", "chart", 1, identity, serialized,
        {"cursor": seam + 300000, "loaded_after": seam, "loaded_before": seam + 300000,
         "initial_input_revision": 1, "historical": True})
    calculator, cursors = Calculator(), {}
    for offset in (600000, 660000, 720000, 780000):
        work = stream.claim()
        payload, _ = calculator.build(work)
        stream.commit(work, payload, delay_ms=0)
        assert stream.events(owner, "page", cursors)[0]["type"] == "status", \
            "tail appends must not invalidate an unchanged historical window"
        with database.begin() as db:
            correction(db, revision, seam + offset, 200001000 + offset)
    with database.begin() as db:
        correction(db, revision, seam + 60000, 201000000, "1.119")
    work = stream.claim()
    payload, _ = calculator.build(work)
    stream.commit(work, payload, delay_ms=0)
    assert stream.events(owner, "page", cursors)[0]["type"] == "reset", \
        "corrections inside the unchanged historical window still require reload"


def test_external_composite_prefix_correction_preserves_shared_main_task(database, monkeypatch):
    composite, revision, seam = populated(database, monkeypatch)
    owner = session(database)
    query = DataQuery(instrument=composite, series_kind="composite", timeframe="M1", provisional=False)
    identity, serialized = resolve(Subscription(client="page", listener="chart", generation=1,
        kind="bars", query=query, dependency_origin=seam))
    state = {"cursor": seam + 540000, "loaded_after": seam + 300000, "loaded_before": seam + 540000,
             "initial_input_revision": 1, "historical": True}
    external = stream.register(owner, "page", "chart", 1, identity, serialized,
                               {**state, "dependency_origin": seam})
    plain = stream.register(owner, "other", "chart", 1, identity, serialized, state)
    assert external["task_id"] == plain["task_id"] and not serialized["indicators"]
    calculator, a, b = Calculator(), {}, {}
    work = stream.claim()
    payload, _ = calculator.build(work)
    stream.commit(work, payload, delay_ms=0)
    assert stream.events(owner, "page", a)[0]["type"] == "status"
    assert stream.events(owner, "other", b)[0]["type"] == "status"
    with database.begin() as db:
        correction(db, revision, seam + 60000, 201000000, "1.119")
    work = stream.claim()
    payload, _ = calculator.build(work)
    stream.commit(work, payload, delay_ms=0)
    event = stream.events(owner, "page", a)[0]
    assert event["type"] == "status" and event["indicator_correction"]
    assert stream.events(owner, "other", b)[0]["type"] == "status"
    with database.begin() as db:
        correction(db, revision, seam + 600000, 202000000)
    work = stream.claim()
    payload, _ = calculator.build(work)
    stream.commit(work, payload, delay_ms=0)
    event = stream.events(owner, "page", a)[0]
    assert event["type"] == "status" and not event.get("indicator_correction")
    # Browser reconnects persist the delivered credential, not the original one.
    stream.register(owner, "page", "chart", 1, identity, serialized,
        {**state, "dependency_origin": seam, "initial_input_revision": event["initial_input_revision"],
         "sequence": event["sequence"]})
    with database.begin() as db:
        correction(db, revision, seam + 660000, 203000000)
    work = stream.claim()
    payload, _ = calculator.build(work)
    stream.commit(work, payload, delay_ms=0)
    assert not stream.events(owner, "page", {})[0].get("indicator_correction")


def test_published_stream_signal_uses_publication_evidence_without_scanning_staging_history(database):
    from alerts.storage import ChartPublication
    from sqlalchemy import event

    query = DataQuery(instrument="BTCUSDT", series_kind="managed", timeframe="M1", published=True)
    identity, serialized = resolve(Subscription(client="page", listener="chart", generation=1,
        kind="bars", query=query))
    work = {"identity": identity}
    calculator = Calculator()
    with database.begin() as db:
        db.add(ChartPublication(instrument_id="BTCUSDT", timeframe="M1", start=60000,
            end=120000, complete_count=1, initialized=True, revision=1))
    with database() as db:
        engine = db.get_bind()
    statements = []

    def observe(connection, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", observe)
    try:
        with database.begin() as db:
            original = calculator._signal(db, work, query)
        with database.begin() as db:
            db.get(ChartPublication, ("BTCUSDT", "M1")).revision += 1
        with database.begin() as db:
            corrected = calculator._signal(db, work, query)
    finally:
        event.remove(engine, "before_cursor_execute", observe)
    assert original != corrected, "publication corrections remain a change trigger"
    assert not any("FROM candles" in sql for sql in statements), \
        "published stream freshness must not rescan raw staging history on every check"


def test_provider_swing_cutoff_uses_source_time_not_daily_display_label(database, monkeypatch):
    from alerts import market_stream_worker as worker
    from alerts import provider_chart as upstream
    from test_provider_cache import META, page, seed

    # A live source candle can carry tomorrow's daily display date. Cached rows
    # beginning after the observation clock remain outside this evaluation.
    payload = page(1000, 15000)
    for bar in payload['bars']:
        bar['chart_time'] = bar['start'] + 20000
    seed(META, 'D1', 35000, payload)
    monkeypatch.setattr(upstream, 'metadata', lambda *_a, **_k: META)
    monkeypatch.setattr(worker, 'now_ms', lambda: 10000)
    owner = session(database)
    query = DataQuery(instrument=META['id'], series_kind='provider', timeframe='D1',
                      indicators=[{'name': 'SWING_SR_V1'}])
    identity, serialized = resolve(Subscription(client='page', listener='daily', generation=1,
                                               kind='bars', query=query))
    stream.register(owner, 'page', 'daily', 1, identity, serialized, {})
    result, _ = Calculator().build(stream.claim())
    assert result['bars'][-1]['start'] == 10000
    assert result['bars'][-1]['chart_time'] == 30000
    display = result['indicators'][0]['presentation']
    assert display['as_of_bar_time'] == 10000
    assert display['as_of_chart_time'] == 30000
