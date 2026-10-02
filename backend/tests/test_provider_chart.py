from datetime import datetime, timedelta

import httpx
import pytest
from alerts import api as api_module
from alerts import provider_chart as provider
from alerts.chart_series import decode, encode
from alerts.config import settings
from alerts.storage import Bar, ImportJob, Instrument, MarketCatalog, MarketDemand
from fastapi.testclient import TestClient
from sqlalchemy import func, select


def stamp(value):
    return int(datetime.fromisoformat(value).timestamp() * 1000)


META = {
    "id": "OANDA:EUR_CHF",
    "source": "oanda",
    "symbol": "EUR_CHF",
    "basis": "bid",
    "calendar": "ny17",
    "precision": 5,
}


def test_ticker_roundtrip_and_legacy_identity():
    for symbol in ("XAUUSD", "BTCUSDT", "OANDA:EUR_CHF"):
        assert decode(symbol) == (symbol, "managed")
        assert decode(encode(symbol, "provider")) == (symbol, "provider")
        assert encode(symbol, "managed") == symbol
    for ticker in ("", "MWP:", "../../passwd", "EUR/USD"):
        with pytest.raises(ValueError):
            decode(ticker)


@pytest.mark.parametrize("frame", provider.FRAMES)
def test_oanda_native_periods_exclusive_labels_and_basis(frame, monkeypatch):
    monkeypatch.setattr(settings, "oanda_token", "test-only")
    before = stamp("2026-10-01T00:00:00+00:00")
    start = stamp("2026-09-01T21:00:00+00:00")

    def handle(request):
        params = request.url.params
        assert params["granularity"] == provider.OANDA_FRAMES[frame]
        assert params["price"] == "B" and params["smooth"] == "false"
        assert params["alignmentTimezone"] == "America/New_York"
        assert params["dailyAlignment"] == "17"
        assert params["weeklyAlignment"] == "Sunday"
        return httpx.Response(
            200,
            json={
                "candles": [
                    {
                        "time": str(start / 1000),
                        "complete": True,
                        "bid": {"o": "1.12345678", "h": "2", "l": "1", "c": "1.2"},
                    },
                    {
                        "time": str(before / 1000),
                        "complete": False,
                        "bid": {"o": "3", "h": "4", "l": "2", "c": "3"},
                    },
                ]
            },
        )

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        page = provider.native_page(META, frame, before, 10, client=client)
    assert page["bars"] and all(b["chart_time"] < before for b in page["bars"])
    assert page["bars"][0]["open"] == "1.12345678"
    assert page["history_boundary"]


def test_oanda_daily_labels_dst_and_current_candle(monkeypatch):
    monkeypatch.setattr(settings, "oanda_token", "test-only")
    starts = [stamp("2026-03-06T22:00:00+00:00"), stamp("2026-03-08T21:00:00+00:00")]

    def handle(request):
        return httpx.Response(
            200,
            json={
                "candles": [
                    {
                        "time": str(at / 1000),
                        "complete": i == 0,
                        "bid": {"o": "1", "h": "2", "l": "1", "c": "2"},
                    }
                    for i, at in enumerate(starts)
                ]
            },
        )

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        page = provider.native_page(
            META, "D1", stamp("2026-03-10T00:00:00+00:00"), 10, client=client
        )
    assert [b["chart_time"] for b in page["bars"]] == [
        stamp("2026-03-07T00:00:00+00:00"),
        stamp("2026-03-09T00:00:00+00:00"),
    ]
    assert page["bars"][-1]["complete"] is False
    assert page["bars"][0]["end"] - page["bars"][0]["start"] == 86400000


def test_ny17_month_end_uses_trading_month_and_dst():
    assert provider._end(stamp("2026-09-30T21:00:00+00:00"), "MN", "ny17") == stamp(
        "2026-10-31T21:00:00+00:00"
    )
    assert provider._end(stamp("2026-02-28T22:00:00+00:00"), "MN", "ny17") == stamp(
        "2026-03-31T21:00:00+00:00"
    )
    assert provider._end(stamp("2026-12-01T00:00:00+00:00"), "MN", "utc0") == stamp(
        "2027-01-01T00:00:00+00:00"
    )


@pytest.mark.parametrize("frame", provider.FRAMES)
def test_binance_native_period_mapping(frame):
    start = stamp("2026-09-01T00:00:00+00:00")
    meta = {**META, "source": "binance", "symbol": "BTCUSDT", "calendar": "utc0", "basis": "last"}

    def handle(request):
        assert request.url.params["interval"] == provider.BINANCE_FRAMES[frame]
        return httpx.Response(
            200, json=[[start, "100.12345678", "110", "90", "101", "12", start + 60000 - 1]]
        )

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        page = provider.native_page(meta, frame, start + 30 * 86400000, 2, client=client)
    assert page["bars"][0]["close"] == "101" and page["basis"] == "last"


def test_errors_are_not_cached_or_history_boundaries(monkeypatch):
    monkeypatch.setattr(settings, "oanda_token", "test-only")
    monkeypatch.setattr(provider.time, "sleep", lambda _: None)
    calls = []

    def handle(request):
        calls.append(request)
        return httpx.Response(429)

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        with pytest.raises(httpx.HTTPStatusError):
            provider.native_page(META, "M5", stamp("2026-10-01T00:00:00+00:00"), 10, client=client)
    assert len(calls) == 3


def test_request_slot_wait_counts_against_actual_http_timeout(monkeypatch):
    from contextlib import contextmanager

    from alerts import market_resources

    clock = [0.0]
    monkeypatch.setattr(provider.time, "monotonic", lambda: clock[0])

    @contextmanager
    def queued_slot(source, *, deadline):
        clock[0] += 6
        yield

    monkeypatch.setattr(market_resources, "request_slot", queued_slot)
    timeouts = []

    def handle(request):
        timeouts.append(request.extensions["timeout"]["read"])
        return httpx.Response(200, json={})

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        provider._request(client, "https://data-api.binance.vision/api/v3/klines", params={}, deadline=8)
    assert timeouts == [2], "HTTP cannot reuse the budget already spent waiting for a slot"


def test_provider_api_deadline_includes_running_http_without_cancelling_shared_page(database, monkeypatch):
    import threading
    import time

    from alerts import provider_cache

    completed = threading.Event()
    cancelled = []
    def slow_page(body):
        event = provider_cache.CANCELLED.get()
        time.sleep(0.2)  # Simulate a request whose per-phase timeouts exceed its total budget.
        cancelled.append(event.is_set())
        completed.set()
        return {"bars": [], "history_boundary": False}

    monkeypatch.setattr(provider, "data", slow_page)
    monkeypatch.setattr(settings, "provider_request_seconds", 0.06)
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            started = time.monotonic()
            response = client.post('/api/charts/data', json={
                'instrument': 'BTCUSDT', 'series_kind': 'provider', 'timeframe': 'M1', 'limit': 200,
            })
            elapsed = time.monotonic() - started
            assert response.status_code == 503
            assert elapsed < 0.15, "HTTP waiter must not inherit each transport phase's full budget"
            assert completed.wait(1), "an already-sent shared page can finish for other readers"
            assert cancelled == [True]
    finally:
        api_module.app.dependency_overrides.clear()


def test_provider_api_no_managed_registration_or_jobs(database, monkeypatch):
    with database.begin() as db:
        db.add(
            MarketCatalog(
                id=META["id"],
                source="oanda",
                symbol="EUR_CHF",
                label="欧元/瑞郎",
                asset_type="CURRENCY",
                calendar="ny17",
                precision=5,
                available=True,
            )
        )
    calls = []

    def fetch(meta, frame, before, count, **kwargs):
        calls.append((meta["id"], frame, count))
        rows = [
            {
                "start": before - (i + 1) * 60000,
                "end": before - i * 60000,
                "chart_time": before - (i + 1) * 60000,
                "complete": True,
                "open": "1",
                "high": "2",
                "low": "1",
                "close": str(1 + i / 100),
            }
            for i in range(count)
        ][::-1]
        return {
            "bars": rows,
            "history_boundary": False,
            "has_more": True,
            "indicators": [],
            "series_kind": "provider",
            "basis": "bid",
            "calendar": "ny17",
            "precision": 5,
        }

    monkeypatch.setattr(provider, "native_page", fetch)
    provider._CACHE.clear()
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            resolved = client.post(
                "/api/market-data/resolve",
                json={"instrument": META["id"], "series_kind": "provider", "timeframe": "M1"},
            )
            assert resolved.status_code == 200 and resolved.json()["series_kind"] == "provider"
            page = client.post(
                "/api/charts/data",
                json={
                    "instrument": META["id"],
                    "series_kind": "provider",
                    "timeframe": "H4",
                    "limit": 5,
                    "indicators": [{"name": "SMA", "params": {"period": 3}}],
                },
            )
            assert page.status_code == 200
            result = page.json()
            assert len(result["bars"]) == 5 and result["series_kind"] == "provider"
            assert len(result["indicators"][0]["series"][0]["values"]) == 5
            assert result["indicators"][0]["series"][0]["values"][0]["value"] is not None
            for route in ("/api/market-data/history", "/api/market-data/history/cache"):
                assert (
                    client.post(
                        route,
                        json={
                            "instrument": META["id"],
                            "series_kind": "provider",
                            "timeframe": "D1",
                        },
                    ).status_code
                    == 422
                )
            quotes = client.post(
                "/api/market-data/quotes",
                json={"symbols": [encode(META["id"], "provider")], "client": "test"},
            )
            assert quotes.json()[0]["n"] == encode(META["id"], "provider")
        with database.begin() as db:
            assert db.get(Instrument, META["id"]) is None
            assert db.scalar(select(func.count()).select_from(ImportJob)) == 0
            assert db.scalar(select(func.count()).select_from(Bar)) == 0
            assert db.scalar(select(func.count()).select_from(MarketDemand)) == 0
        assert (META["id"], "H4", 7) in calls
    finally:
        api_module.app.dependency_overrides.clear()
        provider._CACHE.clear()


def test_provider_cache_namespace_and_copies(monkeypatch):
    calls = []

    def fetch(meta, frame, before, count, **kwargs):
        calls.append((meta["source"], settings.oanda_account_id, frame, meta["basis"]))
        return {"bars": [{"close": "1"}]}

    provider._CACHE.clear()
    monkeypatch.setattr(provider, "native_page", fetch)
    monkeypatch.setattr(settings, "oanda_account_id", "account-a")
    first = provider.cached_page(META, "M5", 100, 2)
    first["bars"][0]["close"] = "mutated"
    assert provider.cached_page(META, "M5", 100, 2)["bars"][0]["close"] == "1"
    monkeypatch.setattr(settings, "oanda_account_id", "account-b")
    provider.cached_page(META, "M5", 100, 2)
    provider.cached_page(META, "H4", 100, 2)
    provider.cached_page({**META, "basis": "mid"}, "H4", 100, 2)
    assert len(calls) == 4
    provider._CACHE.clear()


def test_slow_oanda_page_does_not_queue_independent_binance_source(monkeypatch):
    import threading
    from concurrent.futures import ThreadPoolExecutor

    started, finish = threading.Event(), threading.Event()
    provider._CACHE.clear()

    def fetch(meta, frame, before, count, **kwargs):
        if meta["source"] == "oanda":
            started.set()
            assert finish.wait(2)
        return {"bars": [{"close": "1"}]}

    monkeypatch.setattr(provider, "native_page", fetch)
    with ThreadPoolExecutor(max_workers=2) as executor:
        slow = executor.submit(provider.cached_page, META, "M5", 123, 3, latest=True)
        assert started.wait(1)
        try:
            fast = executor.submit(
                provider.cached_page,
                {**META, "source": "binance", "id": "BTCUSDT"},
                "M5",
                123,
                3,
                latest=True,
            )
            assert fast.result(timeout=0.5)["bars"]
        finally:
            finish.set()
        assert slow.result(timeout=1)["bars"]
    provider._CACHE.clear()


def test_startup_transport_warmup_never_fetches_or_caches_candles(monkeypatch):
    requests = []

    def handle(request):
        requests.append(request)
        assert request.method == "HEAD" and request.url.path == "/"
        assert "Authorization" not in request.headers
        return httpx.Response(200)

    before = dict(provider._CACHE)
    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        monkeypatch.setattr(provider, "pooled_client", lambda _: client)
        provider.warm_clients()
    assert len(requests) == 4 and provider._CACHE == before


def test_quote_refreshes_share_poll_bucket_without_stalling_new_chart_pages(database, monkeypatch):
    calls = []

    def fetch(meta, frame, before, count, **kwargs):
        calls.append((frame, before, count))
        return {"bars": [{"close": "1.25"}]}

    monkeypatch.setattr(provider, "native_page", fetch)
    provider._CACHE.clear()
    monkeypatch.setattr(provider, "now_ms", lambda: 100001)
    assert provider.quote_page(META)["bars"][0]["close"] == "1.25"
    monkeypatch.setattr(provider, "now_ms", lambda: 101001)
    assert provider.quote_page(META)["bars"][0]["close"] == "1.25"
    assert len(calls) == 1, "native details/watchlist calls in one poll window share acquisition"
    monkeypatch.setattr(provider, "now_ms", lambda: 105001)
    provider.quote_page(META)
    assert len(calls) == 2, "new poll window acquires current provider M1"
    provider._CACHE.clear()


def test_earliest_probe_uses_positive_epoch_and_does_not_write_managed_data(database):
    meta = {**META, "id": "OANDA:EARLIEST_TEST", "symbol": "EUR_GBP"}
    provider._EARLIEST.clear()
    first = stamp("2002-05-06T09:00:00+00:00")
    calls = []

    def handle(request):
        calls.append(request)
        assert request.url.params["from"] == "1"
        assert request.url.params["count"] == "1"
        assert request.url.params["granularity"] == "M1"
        return httpx.Response(
            200, json={"candles": [{"time": str(first / 1000), "complete": True}]}
        )

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        assert provider.earliest_m1(meta, client=client) == first
        assert provider.earliest_m1(meta, client=client) == first
    assert len(calls) == 1
    with database.begin() as db:
        assert db.scalar(select(func.count()).select_from(Bar)) == 0
        assert db.scalar(select(func.count()).select_from(ImportJob)) == 0


@pytest.mark.parametrize('context', [
    {'chart_count': True}, {'chart_count': '2'}, {'chart_count': 0},
    {'chart_count': 9}, {'chart_count': 1, 'focused': 'true'},
    {'chart_count': 1, 'historical_navigation': 1},
])
def test_native_history_context_rejects_coercion(context):
    from alerts.chart_api import DataQuery
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        DataQuery(instrument='BTCUSDT', series_kind='provider', timeframe='M5', native_history=context)


def test_optional_history_context_is_provider_only_and_unknown_fields_stay_ignored():
    from alerts.chart_api import DataQuery
    from pydantic import ValidationError
    base = {'instrument': 'BTCUSDT', 'timeframe': 'M5', 'countBack': 200}
    with pytest.raises(ValidationError):
        DataQuery(**base, native_history={'chart_count': 1})
    query = DataQuery(**base, series_kind='provider', future_optional_context={'value': 1})
    assert query.count_back == 200 and query.native_history is None
    with pytest.raises(ValidationError):
        DataQuery(**base, series_kind='provider', before=1000, **{'from': 2000},
                  native_history={'chart_count': 1})


@pytest.mark.parametrize('source,count', [('binance',200),('binance',700),('binance',1000),
                                         ('binance',1200),('oanda',3999)])
def test_cold_optional_does_not_add_candles_http(source, count, database, monkeypatch):
    from alerts import provider_cache as cache
    from alerts.chart_api import DataQuery
    monkeypatch.setattr(settings, 'oanda_token', 'test-only')
    meta = {**META, 'source': source, 'symbol': 'BTCUSDT' if source == 'binance' else 'EUR_CHF',
            'calendar': 'utc0' if source == 'binance' else 'ny17'}
    monkeypatch.setattr(provider, 'metadata', lambda _: meta)
    before = stamp('2026-10-01T00:00:00+00:00')
    attempts = []
    def handle(request):
        params = request.url.params
        amount = int(params['limit' if source == 'binance' else 'count'])
        end = int(params['endTime']) + 1 if source == 'binance' else int(Decimal(params['to']) * 1000)
        attempts.append(amount)
        times = range(end - amount * 300000, end, 300000)
        if source == 'binance':
            payload = [[t, '1', '3', '0', '2', '0', t + 299999] for t in times]
        else:
            payload = {'candles': [{'time': str(t / 1000), 'complete': True,
                                   'bid': {'o': '1', 'h': '3', 'l': '0', 'c': '2'}} for t in times]}
        return httpx.Response(200, json=payload)
    from decimal import Decimal
    body = DataQuery(instrument='BTCUSDT', series_kind='provider', timeframe='M5', before=before,
                     countBack=count, native_history={'chart_count': 1, 'focused': True})
    results = []
    for enabled in [False, True]:
        meta = {**meta, 'symbol': ('BTCUSDT' if source == 'binance' else 'EUR_CHF') + str(enabled)}
        attempts.clear()
        monkeypatch.setattr(settings, 'provider_native_history_buffer', enabled)
        with httpx.Client(transport=httpx.MockTransport(handle)) as client:
            monkeypatch.setattr(provider, 'pooled_client', lambda _: client)
            result = cache.data(body)
        results.append((list(attempts), result))
    off, on = results
    assert len(off[0]) == len(on[0]), 'compare real HTTP calls, not native_page invocations'
    assert on[1]['mandatory_count'] == count
    assert off[1]['bars'] == on[1]['bars'][-count:]


@pytest.mark.parametrize('source', ['binance', 'oanda'])
@pytest.mark.parametrize('frame', ['D1', 'W1', 'MN'])
def test_high_period_optional_stops_after_mandatory_http(source, frame, monkeypatch):
    """Exercise real adapter label filtering and count padding, not page mocks."""
    from decimal import Decimal
    from zoneinfo import ZoneInfo

    monkeypatch.setattr(settings, 'oanda_token', 'test-only')
    before = stamp('2026-10-01T00:00:00+00:00')
    zone = ZoneInfo('America/New_York') if source == 'oanda' else ZoneInfo('UTC')
    starts = []
    for day in range(1200):
        moment = datetime(2023, 7, 1, tzinfo=zone) + timedelta(days=day)
        if frame == 'W1' and moment.weekday() != (6 if source == 'oanda' else 0):
            continue
        if frame == 'MN' and moment.day != 1:
            continue
        moment = moment.replace(hour=17 if source == 'oanda' else 0)
        starts.append(int(moment.timestamp() * 1000))
    attempts = []

    def handle(request):
        params = request.url.params
        amount = int(params['limit' if source == 'binance' else 'count'])
        cursor = int(params['endTime']) + 1 if source == 'binance' else int(Decimal(params['to']) * 1000)
        times = [t for t in starts if t < cursor][-amount:]
        assert len(times) == amount, 'fixture has sufficient older native periods'
        attempts.append(amount)
        if source == 'binance':
            return httpx.Response(200, json=[[t, '1', '3', '0', '2', '0',
                                             provider._end(t, frame, 'utc0') - 1] for t in times])
        return httpx.Response(200, json={'candles': [
            {'time': str(Decimal(t) / 1000), 'complete': True,
             'bid': {'o': '1', 'h': '3', 'l': '0', 'c': '2'}} for t in times]})

    meta = {**META, 'source': source, 'calendar': 'ny17' if source == 'oanda' else 'utc0'}
    results = []
    for optional in [0, 5]:
        attempts.clear()
        with httpx.Client(transport=httpx.MockTransport(handle)) as client:
            result = provider.native_page(meta, frame, before, 8, optional=optional, client=client)
        results.append((list(attempts), result))
    off, on = results
    assert len(off[0]) == len(on[0]) == 1
    assert len(on[1]['bars']) > 8
    assert off[1]['bars'] == on[1]['bars'][-8:]
    assert all(bar['chart_time'] < before for bar in on[1]['bars'])


@pytest.mark.parametrize('field,value', [('countBack',True),('countBack','200'),('countBack',200.0),
                                       ('before','1000000'),('from',False),('firstDataRequest',1)])
def test_native_history_rejects_number_and_time_coercion(field, value):
    from alerts.chart_api import DataQuery
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        DataQuery(**{'instrument':'BTCUSDT','series_kind':'provider','timeframe':'M5',
                     'native_history':{'chart_count':1},field:value})


def test_native_capacity_error_is_structured_and_never_no_data(database, monkeypatch):
    monkeypatch.setattr(provider, 'metadata', lambda _: META)
    monkeypatch.setattr(provider, 'native_page', lambda *a, **k: pytest.fail('known N+H capacity failure must not fetch'))
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: 'test'
    try:
        with TestClient(api_module.app) as client:
            response = client.post('/api/charts/data', json={
                'instrument': META['id'], 'series_kind': 'provider', 'timeframe': 'M5',
                'countBack': 20000, 'native_history': {'chart_count': 1, 'focused': True},
                'indicators': [{'name': 'EMA', 'params': {'period': 20}}]})
        assert response.status_code == 422
        assert response.json()['detail']['code'] == 'NATIVE_HISTORY_CAPACITY_EXCEEDED'
        assert 'history_boundary' not in response.json()
    finally:
        api_module.app.dependency_overrides.clear()


def test_provider_quotes_use_previous_complete_native_close(database, monkeypatch):
    from alerts import api as api_module
    from alerts.domain import Calendar, session_bounds
    from alerts.storage import instant, ms
    from fastapi.testclient import TestClient
    start = 1790944200000
    session_start = ms(session_bounds(instant(start), Calendar(META["calendar"]))[0])
    latest = {"start": start, "close": "120"}
    calls = []
    def page(meta, frame, before, count, **kwargs):
        calls.append((frame, count))
        return {"bars": [latest]} if frame == "M1" else {"bars": [
            {"complete": True, "end": session_start, "close": "100"},
            {"complete": False, "end": session_start + 86400000, "close": "110"},
        ]}
    monkeypatch.setattr(provider, "cached_page", page)
    monkeypatch.setattr(provider, "metadata", lambda _: {**META, "name": "Test pair"})
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            value = client.post("/api/market-data/quotes", json={"symbols": ["MWP:EURUSD"]}).json()[0]["v"]
            assert value["lp"] == 120 and value["prev_close_price"] == 100
            assert value["ch"] == 20 and value["chp"] == 20
            assert value["bid"] == 120
            def unavailable(*args):
                raise RuntimeError("previous session unavailable")
            monkeypatch.setattr(provider, "quote_previous_close", unavailable)
            value = client.post("/api/market-data/quotes", json={"symbols": ["MWP:EURUSD"]}).json()[0]["v"]
            assert value["lp"] == 120 and "ch" not in value
    finally:
        api_module.app.dependency_overrides.clear()
