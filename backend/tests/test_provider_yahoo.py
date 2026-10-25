"""Yahoo native contracts through adapter/cache/service, without upstream network."""

import time
from contextlib import contextmanager
from types import SimpleNamespace

import pandas as pd
import pytest
from alerts import provider_cache as cache
from alerts import provider_service as service
from alerts import provider_yahoo as yahoo
from alerts import storage, yahoo_catalog
from alerts.config import settings
from alerts.provider_capabilities import YAHOO_INTERVALS
from sqlalchemy import func, select

META = {
    "id": yahoo.stable_id("CL=F"),
    "source": "yahoo",
    "symbol": "CL=F",
    "basis": "last",
    "calendar": "yahoo",
    "precision": 8,
    "adjustment": "supplier",
    "volume_kind": "contracts",
    "volume_unit": "合约",
    "first_trade_ms": 0,
}


def stamp(value):
    return int(pd.Timestamp(value).timestamp() * 1000)


@pytest.fixture
def adapter(monkeypatch):
    @contextmanager
    def operation(deadline, **kwargs):
        yield None

    monkeypatch.setattr(yahoo, "_operation", operation)
    calls = []
    data = pd.DataFrame(
        {
            "Open": [17.73, -14.0],
            "High": [18.26, -3.7],
            "Low": [-40.32, -16.74],
            "Close": [-37.63, -6.5],
            "Volume": [247947, 0],
        },
        index=pd.DatetimeIndex(["2020-04-20", "2020-04-21"], tz="America/New_York"),
    )

    class Ticker:
        _price_history = SimpleNamespace(
            _history_metadata={"firstTradeDate": pd.Timestamp("2000-08-23", tz="America/New_York")}
        )

        def history(self, **kwargs):
            calls.append(kwargs)
            return data

    monkeypatch.setattr(yahoo.yf, "Ticker", lambda *a, **k: Ticker())
    return data, calls


def test_native_date_labels_negative_prices_and_sdk_timestamp_metadata(adapter):
    data, calls = adapter
    page = yahoo.native_page(
        META, "D1", stamp("2020-04-22T00:00:00Z"), 2, deadline=time.monotonic() + 2
    )
    assert len(page["bars"]) == 2
    assert float(page["bars"][0]["low"]) == -40.32
    assert page["bars"][0]["start"] == stamp("2020-04-20T04:00:00Z")
    assert page["bars"][0]["chart_time"] == stamp("2020-04-20T00:00:00Z")
    assert page["bars"][0]["complete"] is True
    assert page["bars"][-1]["complete"] is False
    assert page["bars"][-1]["volume"] is None
    assert calls[0]["interval"] == "1d" and not calls[0]["repair"]
    assert not calls[0]["auto_adjust"] and not calls[0]["back_adjust"]


def test_unsupported_period_never_fetches_or_creates_dataset(database, adapter, monkeypatch):
    monkeypatch.setattr(service.upstream, "metadata", lambda ident: META)
    _, calls = adapter
    for frame in ("M30", "H4"):
        with pytest.raises(ValueError):
            yahoo.native_page(META, frame, stamp("2020-04-22T00:00:00Z"), 2)
        with pytest.raises(ValueError):
            cache.ensure(META, frame)
        with pytest.raises(ValueError):
            service.subscribe("test", "listener", META["id"], frame)
    assert calls == []


def test_stock_and_etf_adjusted_native_intervals(adapter):
    _, calls = adapter
    for frame in YAHOO_INTERVALS:
        meta = {**META, "symbol": "AAPL", "adjustment": "auto", "volume_kind": "shares"}
        yahoo.native_page(meta, frame, storage.now_ms() + 1, 1, deadline=time.monotonic() + 2)
    assert [c["interval"] for c in calls] == list(YAHOO_INTERVALS.values())
    assert all(c["auto_adjust"] and not c["repair"] and not c["back_adjust"] for c in calls)


def test_managed_archive_reuses_sdk_with_explicit_unadjusted_prices(adapter, monkeypatch):
    from alerts.history_mode_sources import dataset_identity, source_identity

    data, calls = adapter
    data.loc[:, ["Open", "High", "Low", "Close"]] = [[10, 12, 9, 11], [11, 13, 10, 12]]
    monkeypatch.setattr(yahoo, "now_ms", lambda: stamp("2020-04-22T02:00:00Z"))
    info = {"timezone": "America/New_York", "session": "0930-1600:23456",
            "volume_kind": "quantity", "volume_unit": "shares"}
    identity = source_identity(dataset_identity("yahoo", "AAPL", "base_d1", "none"), "D1", info)
    batch = yahoo.archive_page(identity, stamp("2020-04-20T00:00:00Z"), stamp("2020-04-22T00:00:00Z"))
    assert len(batch.rows) == 2 and all(row.complete for row in batch.rows)
    assert batch.rows[-1].end == stamp("2020-04-21T20:00:00Z")
    assert batch.rows[-1].start == stamp("2020-04-21T00:00:00Z")
    assert all(not call["auto_adjust"] and not call["back_adjust"] and not call["repair"] for call in calls)
    data.iloc[0, data.columns.get_loc("Volume")] = -1
    with pytest.raises(ValueError, match="成交量"):
        yahoo.archive_page(identity, stamp("2020-04-20T00:00:00Z"), stamp("2020-04-22T00:00:00Z"))


def test_local_id_and_scope():
    assert len(yahoo.stable_id("GC=F")) == 38
    assert yahoo.stable_id("gc=f") == yahoo.stable_id("GC=F")
    assert yahoo.stable_id("GC=F") != yahoo.stable_id("CL=F")
    assert yahoo.allowed({"symbol": "AAPL", "quoteType": "EQUITY", "exchange": "NMS"})
    for symbol, exchange in [
        ("0700.HK", "HKG"),
        ("600000.SS", "SHG"),
        ("000001.SZ", "SHZ"),
        ("SHOP.TO", "TOR"),
    ]:
        assert not yahoo.allowed({"symbol": symbol, "quoteType": "EQUITY", "exchange": exchange})


def test_yahoo_rounds_include_seven_frames_and_neighbor_buffers(database):
    key = cache.ensure(META, "D1")
    service.activate("yahoo-test", key, stamp("2020-04-22T00:00:00Z"), 20)
    with storage.transaction() as db:
        interest = db.scalar(select(storage.ProviderInterest))
        assert len(interest.targets) == 16
        assert {t["frame"] for t in interest.targets} == set(YAHOO_INTERVALS)
        assert [t["frame"] for t in interest.targets[:8]] == [
            "D1",
            "D1",
            "W1",
            "M5",
            "M1",
            "MN",
            "H1",
            "M15",
        ]
        assert [t["frame"] for t in interest.targets[8:]] == [
            "D1",
            "D1",
            "W1",
            "M5",
            "M1",
            "MN",
            "H1",
            "M15",
        ]


def test_temporary_window_preserves_cached_prices_and_never_sets_earliest(database):
    key = cache.ensure(META, "M1")
    lease = cache.claim(key)
    now = storage.now_ms()
    page = {
        "bars": [],
        "history_boundary": False,
        "coverage": [],
        "boundary_evidence": {
            "kind": "rolling_window",
            "left": 1000,
            "confirmed_at": now,
            "retry_at": now + 60000,
        },
    }
    cache.commit_page(key, lease, page, 500, now)
    cache.release(key, lease)
    state = cache.snapshot(key, 500, 100)
    assert state["satisfied"] and state["window_limit"] and not state["history_boundary"]
    with storage.transaction() as db:
        assert not db.get(storage.ProviderDataset, key).earliest


@pytest.mark.parametrize("buffer,total,count,delivered", [(False, 10, 2, 2), (True, 3000, 100, 2100)])
def test_cached_minutes_remain_pageable_at_rolling_window(
    database, monkeypatch, buffer, total, count, delivered
):
    from alerts.chart_api import DataQuery

    monkeypatch.setattr(settings, "provider_native_history_buffer", buffer)
    monkeypatch.setattr(cache.upstream, "metadata", lambda ident: META)
    monkeypatch.setattr(cache.upstream, "native_page", lambda *a, **k: pytest.fail("use cached history"))
    left = stamp("2026-01-02T00:00:00Z")
    before = left + total * 60000
    bars = [{"start": left + index * 60000, "end": left + (index + 1) * 60000,
             "chart_time": left + index * 60000, "open": "1", "high": "2",
             "low": "0", "close": "1", "complete": True}
            for index in range(total)]
    key = cache.ensure(META, "M1")
    lease = cache.claim(key)
    cache.commit_page(key, lease, {
        "bars": bars, "history_boundary": False, "coverage": [[left, before]],
        "boundary_evidence": {"kind": "rolling_window", "left": before + 60000,
                              "retry_at": storage.now_ms() + 60000},
    }, before, storage.now_ms())
    cache.release(key, lease)

    def read(cursor):
        return cache.data(DataQuery(instrument=META["id"], timeframe="M1", series_kind="provider",
                                    before=cursor, limit=count, countBack=count,
                                    native_history={"chart_count": 1, "focused": True}))

    result = read(before)
    assert len(result["bars"]) == delivered
    assert result["window_limit"] and result["has_more"] and not result["history_boundary"]
    seen = [bar["chart_time"] for bar in result["bars"]]
    while result["has_more"]:
        result = read(result["bars"][0]["chart_time"])
        assert result["bars"], "a page with more cached history must advance"
        seen.extend(bar["chart_time"] for bar in result["bars"])
    assert sorted(seen) == [bar["chart_time"] for bar in bars]


def test_request_failure_never_commits_coverage(database, monkeypatch):
    key = cache.ensure(META, "M1")

    def failure(*a, **k):
        raise yahoo.YahooError("rate_limited", "Yahoo 限流")

    monkeypatch.setattr(cache.upstream, "native_page", failure)
    with pytest.raises(yahoo.YahooError):
        cache.fetch_page(key, META, "M1", 10000, 10, time.monotonic() + 2)
    with storage.transaction() as db:
        ds = db.get(storage.ProviderDataset, key)
        assert ds.coverage == [] and not ds.earliest and ds.lease_token is None


def test_event_change_revokes_all_adjusted_periods_and_fences_old_owner(database, monkeypatch):
    monkeypatch.setattr(settings, "yahoo_enabled", True)
    info = {
        "symbol": "AAPL",
        "quoteType": "EQUITY",
        "exchange": "NMS",
        "exchangeTimezoneName": "America/New_York",
        "lastSplitDate": 100,
        "lastSplitFactor": "4:1",
    }
    original = yahoo._metadata(info)
    yahoo_catalog._store(original)
    meta = {
        **META,
        **original,
        "symbol": "AAPL",
        "adjustment": "auto",
        "id": yahoo.stable_id("AAPL"),
    }
    key = cache.ensure(meta, "D1")
    lease = cache.claim(key)
    changed = yahoo._metadata({**info, "lastSplitDate": 200})
    yahoo_catalog._store(changed)
    with storage.transaction() as db:
        ds = db.get(storage.ProviderDataset, key)
        assert ds.generation == lease[1] + 1 and ds.revision == 1
        assert ds.coverage == [] and ds.metadata_json["revalidation_generation"] == ds.generation
    with pytest.raises(TimeoutError):
        cache.commit_page(
            key,
            lease,
            {"bars": [], "history_boundary": False, "coverage": []},
            1000,
            storage.now_ms(),
        )


def test_default_proxy_is_required_and_disabled_source_is_explicit(monkeypatch):
    monkeypatch.setattr(settings, "yahoo_enabled", True)
    monkeypatch.setattr(settings, "yahoo_proxy", "")
    monkeypatch.setattr(settings, "market_proxy", "")
    with pytest.raises(yahoo.YahooError, match="代理未配置"):
        yahoo.metadata("AAPL")
    monkeypatch.setattr(settings, "yahoo_enabled", False)
    with pytest.raises(yahoo.YahooError, match="未启用"):
        yahoo.metadata("AAPL")


def test_yahoo_resource_lanes_share_one_operation_and_cooldown(database):
    from alerts.market_resources import acquire, cooldown, release

    now = storage.now_ms()
    token = acquire("yahoo", "history", now)
    assert token
    assert acquire("yahoo", "chart", now + 1001) is None
    release("yahoo", token)
    assert acquire("yahoo", "chart", now + 1001)
    cooldown("yahoo", retry_seconds=60)
    assert acquire("yahoo", "realtime", now + 2000) is None


def test_yahoo_never_creates_managed_history(database, monkeypatch):
    monkeypatch.setattr(settings, "yahoo_enabled", True)
    yahoo_catalog.seed()
    from alerts.market_data import resolve
    from fastapi import HTTPException

    with storage.transaction() as db:
        with pytest.raises(HTTPException, match="平台系列"):
            resolve(db, yahoo.stable_id("GC=F"))
        assert db.scalar(select(func.count()).select_from(storage.ChartHistoryPlan)) == 0
        assert db.scalar(select(func.count()).select_from(storage.Bar)) == 0


def test_chart_library_uppercase_hash_routes_to_same_catalog_id(database, monkeypatch):
    from alerts.chart_series import decode, encode

    ident = yahoo.stable_id("AAPL")
    assert decode("MWP:" + ident.upper()) == (ident, "provider")
    assert encode(ident.upper(), "provider") == "MWP:" + ident
    monkeypatch.setattr(settings, "yahoo_enabled", True)
    yahoo_catalog._store(
        yahoo._metadata(
            {
                "symbol": "AAPL",
                "quoteType": "EQUITY",
                "exchange": "NMS",
                "exchangeTimezoneName": "America/New_York",
            }
        )
    )
    assert yahoo_catalog.chart_metadata(ident.upper())["id"] == ident


def test_successful_empty_weekend_is_coverage_not_lifecycle(database, monkeypatch):
    raw = SimpleNamespace(
        chart_response=(
            200,
            {
                "chart": {
                    "error": None,
                    "result": [{"timestamp": [], "meta": {"firstTradeDate": 100}}],
                }
            },
        )
    )

    @contextmanager
    def operation(deadline):
        yield raw

    monkeypatch.setattr(yahoo, "_operation", operation)

    class Ticker:
        _price_history = SimpleNamespace(_history_metadata={})

        def history(self, **kwargs):
            raise yahoo.YFPricesMissingError("AAPL", "weekend")

    monkeypatch.setattr(yahoo.yf, "Ticker", lambda *a, **k: Ticker())
    page = yahoo.native_page(META, "M1", storage.now_ms() + 1, 10, deadline=time.monotonic() + 2)
    assert page["bars"] == [] and page["coverage"] and not page["history_boundary"]
    key = cache.ensure(META, "M1")
    lease = cache.claim(key)
    cache.commit_page(key, lease, page, storage.now_ms() + 1, storage.now_ms())
    with storage.transaction() as db:
        assert db.get(storage.ProviderDataset, key).coverage
        assert not db.get(storage.ProviderDataset, key).earliest


def test_minute_window_rejection_has_no_success_coverage(adapter, monkeypatch):
    def fail(*args, **kwargs):
        raise yahoo.YFPricesMissingError(
            "AAPL", "The requested range must be within the last 30 days"
        )

    monkeypatch.setattr(yahoo, "_history", fail)
    page = yahoo.native_page(META, "M1", storage.now_ms() + 1, 1, deadline=time.monotonic() + 2)
    assert page["coverage"] == [] and not page["history_boundary"]
    assert page["boundary_evidence"]["reason"] == "upstream_window_rejected"


def test_dst_daily_and_real_calendar_month_end(adapter):
    data, _ = adapter
    meta = {**META, "symbol": "AAPL", "volume_kind": "shares"}
    data.index = pd.DatetimeIndex(["2026-03-06", "2026-03-09"], tz="America/New_York")
    page = yahoo.native_page(
        meta, "D1", stamp("2026-03-10T00:00:00Z"), 2, deadline=time.monotonic() + 2
    )
    assert page["bars"][0]["start"] == stamp("2026-03-06T05:00:00Z")
    assert page["bars"][1]["start"] == stamp("2026-03-09T04:00:00Z")
    assert page["bars"][1]["chart_time"] == stamp("2026-03-09T00:00:00Z")
    data.index = pd.DatetimeIndex(["2026-02-01", "2026-03-01"], tz="America/New_York")
    month = yahoo.native_page(
        meta, "MN", stamp("2026-04-01T00:00:00Z"), 2, deadline=time.monotonic() + 2
    )
    assert month["bars"][0]["end"] == stamp("2026-03-01T05:00:00Z")
    assert month["bars"][1]["end"] == stamp("2026-04-01T04:00:00Z")


def test_revalidation_can_replace_complete_bar_with_incomplete_observation(database):
    key = cache.ensure(META, "D1")

    def page(close, complete):
        return {
            "bars": [
                {
                    "start": 1000,
                    "end": 2000,
                    "chart_time": 1000,
                    "open": "1",
                    "high": "2",
                    "low": "-2",
                    "close": close,
                    "complete": complete,
                    "volume": None,
                    "volume_complete": False,
                }
            ],
            "history_boundary": False,
            "coverage": [[1000, 3000]],
        }

    first = cache.claim(key)
    cache.commit_page(key, first, page("1", True), 3000, storage.now_ms())
    cache.release(key, first)
    revision = cache.claim(key)
    cache.commit_page(
        key, revision, {**page("-1", False), "revalidation": True}, 3000, storage.now_ms() + 1
    )
    state = cache.snapshot(key, 3000, 1)
    assert state["bars"][0]["close"] == "-1" and state["bars"][0]["complete"] is False


def test_daily_old_window_revalidation_is_bounded_and_shared(database, monkeypatch):
    key = cache.ensure(META, "D1")
    lease = cache.claim(key)
    row = {
        "start": 1000,
        "end": 2000,
        "chart_time": 1000,
        "open": "1",
        "high": "2",
        "low": "0",
        "close": "1",
        "complete": True,
        "volume": None,
        "volume_complete": False,
    }
    page = {"bars": [row], "history_boundary": False, "coverage": [[0, 3000]]}
    cache.commit_page(key, lease, page, 3000, storage.now_ms() - 86400001)
    cache.release(key, lease)
    calls = []

    def fetch(meta, frame, before, count, **kwargs):
        calls.append((frame, before, count))
        return {**page, "bars": [{**row, "close": "1.5", "complete": False}]}

    monkeypatch.setattr(cache.upstream, "native_page", fetch)
    result = cache.read(META, "D1", 3000, 1, deadline=time.monotonic() + 2)
    assert result["bars"][0]["close"] == "1.5"
    cache.read(META, "D1", 3000, 1, deadline=time.monotonic() + 2)
    assert calls == [("D1", 3000, 1)]


def test_quote_refresh_merges_inflight_and_preserves_market_basis(database, monkeypatch):
    import threading
    from concurrent.futures import ThreadPoolExecutor

    service._QUOTE_CACHE.clear()
    service._QUOTE_INFLIGHT.clear()
    started = threading.Event()
    finish = threading.Event()
    calls = []

    def quote(meta, deadline):
        calls.append(meta["id"])
        started.set()
        assert finish.wait(2)
        return {
            "price": "-37.63",
            "previous_close": "18.27",
            "quote_time": 1000,
            "fetched_at": 2000,
            "delay_seconds": 1800,
            "status": "ok",
            "basis": "Yahoo 市场报价",
        }

    monkeypatch.setattr(yahoo, "quote", quote)
    with ThreadPoolExecutor(max_workers=2) as pool:
        one = pool.submit(service.yahoo_quote, META, deadline=time.monotonic() + 3)
        assert started.wait(1)
        two = pool.submit(service.yahoo_quote, META, deadline=time.monotonic() + 3)
        finish.set()
        assert one.result() == two.result()
    assert service.yahoo_quote(META)["price"] == "-37.63" and len(calls) == 1
    service._QUOTE_CACHE.clear()


def test_quote_failure_retains_last_time_with_explicit_fetch_failure(database, monkeypatch):
    service._QUOTE_CACHE[META["id"]] = (
        0,
        {"price": "1", "quote_time": 1000, "fetched_at": 2000, "status": "ok"},
    )

    def fail(*args, **kwargs):
        raise TimeoutError("network")

    monkeypatch.setattr(yahoo, "quote", fail)
    quote = service.yahoo_quote(META)
    assert (
        quote["status"] == "fetch_failed"
        and quote["quote_time"] == 1000
        and quote["fetched_at"] == 2000
    )
    service._QUOTE_CACHE.clear()


def test_proxy_and_absolute_deadline_cover_every_sdk_http(monkeypatch):
    recorded = []

    def request(self, method, url, **kwargs):
        recorded.append(kwargs)
        return SimpleNamespace(status_code=200)

    monkeypatch.setattr(yahoo.requests.Session, "request", request)
    s = yahoo._Session(
        impersonate="chrome",
        trust_env=False,
        proxies={"http": "http://test.invalid", "https": "http://test.invalid"},
    )
    s.deadline = time.monotonic() + 0.1
    for url in [
        "https://fc.yahoo.com",
        "https://query1.finance.yahoo.com/v1/test/getcrumb",
        "https://query1.finance.yahoo.com/v7/finance/quote",
        "https://query1.finance.yahoo.com/v1/finance/search",
    ]:
        s.request("GET", url, timeout=30)
    assert all(
        r["timeout"] <= 0.1 and r["proxies"]["https"] == "http://test.invalid" for r in recorded
    )
    s.deadline = time.monotonic() - 1
    with pytest.raises(TimeoutError):
        s.request("GET", "https://fc.yahoo.com")
    assert len(recorded) == 4
    s.close()


def test_short_lifecycle_is_confirmed_by_metadata_and_successful_window(adapter):
    data, _ = adapter
    data.index = pd.DatetimeIndex(["2026-01-02", "2026-01-05"], tz="America/New_York")
    yahoo.yf.Ticker("CL=F")._price_history._history_metadata["firstTradeDate"] = data.index[0]
    meta = {**META, "first_trade_ms": stamp("2026-01-02T05:00:00Z")}
    # Need more bars than this new instrument has; never confuse short history
    # with a provider's count page exhaustion heuristic.
    page = yahoo.native_page(
        meta, "D1", stamp("2026-01-06T00:00:00Z"), 1000, deadline=time.monotonic() + 2
    )
    assert page["history_boundary"] and page["boundary_evidence"]["kind"] == "lifecycle"
    assert page["coverage"] == [[0, stamp("2026-01-06T00:00:00Z")]]


@pytest.mark.parametrize("invalid_price", [float("nan"), float("inf"), None])
def test_invalid_ohlc_never_commits_lifecycle_or_replaces_cached_prices(
    database, adapter, monkeypatch, invalid_price
):
    data, _ = adapter
    data.index = pd.DatetimeIndex(["2026-01-02", "2026-01-05"], tz="America/New_York")
    yahoo.yf.Ticker("CL=F")._price_history._history_metadata["firstTradeDate"] = data.index[0]
    meta = {**META, "first_trade_ms": stamp("2026-01-02T05:00:00Z")}
    before = stamp("2026-01-06T00:00:00Z")
    valid = yahoo.native_page(meta, "D1", before, 1000)
    key = cache.ensure(meta, "D1")
    lease = cache.claim(key)
    observed_at = storage.now_ms() - settings.yahoo_metadata_ttl_seconds * 1000 - 1
    cache.commit_page(key, lease, valid, before, observed_at)
    cache.release(key, lease)
    original = cache.snapshot(key, before, 1000)

    data.loc[data.index[0], "High"] = invalid_price
    # Include the listing boundary: dropping this row must not turn a failed
    # revalidation into proof that all history was successfully observed.
    with pytest.raises(yahoo.YahooError) as failure:
        cache.fetch_page(key, meta, "D1", before, 1000, time.monotonic() + 2, revalidate=True)
    assert failure.value.status == "invalid_data"
    current = cache.snapshot(key, before, 1000)
    assert current["bars"] == original["bars"]
    assert current["cache_revision"] == original["cache_revision"]
    assert current["history_boundary"] == original["history_boundary"]
    assert current["interval"] == original["interval"]

    fresh = {**meta, "symbol": "NEW=F"}
    fresh_key = cache.ensure(fresh, "D1")
    with pytest.raises(yahoo.YahooError):
        cache.fetch_page(fresh_key, fresh, "D1", before, 1000, time.monotonic() + 2)
    empty = cache.snapshot(fresh_key, before, 1000)
    assert empty["bars"] == [] and empty["interval"] is None
    assert not empty["history_boundary"]


@pytest.mark.parametrize("event,value", [("Dividends", 0.25), ("Stock Splits", 4), ("Capital Gains", 0.5)])
def test_sdk_event_without_prices_does_not_reject_or_complete_price_history(
    adapter, monkeypatch, event, value
):
    from yfinance import utils

    # Exercise the pinned SDK's real merge: an event after the last quotation
    # creates an OHLC-NaN row which actions=True intentionally retains.
    quotes = pd.DataFrame({"Open": [10.0], "High": [12.0], "Low": [9.0],
                           "Close": [11.0], "Adj Close": [11.0], "Volume": [1000]},
                          index=pd.DatetimeIndex(["2026-01-02"], tz="America/New_York"))
    events = pd.DataFrame({event: [value]},
                          index=pd.DatetimeIndex(["2026-01-05"], tz="America/New_York"))
    data = utils.auto_adjust(utils.safe_merge_dfs(quotes, events, "1d"))
    assert data.loc[events.index[0], ["Open", "High", "Low", "Close"]].isna().all()
    monkeypatch.setattr(yahoo, "_history", lambda *a, **k: data)
    result = yahoo.native_page({**META, "adjustment": "auto"}, "D1",
                               stamp("2026-01-06T00:00:00Z"), 1)
    assert len(result["bars"]) == 1
    assert result["bars"][0]["chart_time"] == stamp("2026-01-02T00:00:00Z")
    assert result["bars"][0]["close"] == "11.0"
    assert not result["bars"][0]["complete"], "an event cannot prove a successor price bar"
    assert not result["history_boundary"]


@pytest.mark.parametrize("prices,volume,dividend", [
    ([None, None, None, None], 0, 0),
    ([None, None, None, None], 100, 0.25),
    ([1, None, 0, 1], 0, 0.25),
    ([float("inf")] * 4, 0, 0.25),
])
def test_invalid_price_rows_cannot_masquerade_as_corporate_actions(
    adapter, prices, volume, dividend
):
    data, _ = adapter
    data.loc[data.index[0], ["Open", "High", "Low", "Close"]] = prices
    data.loc[data.index[0], "Volume"] = volume
    data.loc[data.index[0], "Dividends"] = dividend
    with pytest.raises(yahoo.YahooError) as failure:
        yahoo.native_page(META, "D1", stamp("2020-04-22T00:00:00Z"), 2)
    assert failure.value.status == "invalid_data"


def test_switch_off_stops_new_background_work(database, monkeypatch):
    monkeypatch.setattr(settings, "yahoo_enabled", False)
    assert service.warm_step("yahoo", "old_cursor") == ("old_cursor", False)


def test_yahoo_csv_keeps_original_columns_negative_prices_and_price_basis():
    import csv
    import io

    from alerts.chart_export import chart_csv

    page = {
        "source": "yahoo",
        "symbol": "CL=F",
        "adjustment": "supplier",
        "basis": "last",
        "calendar": "yahoo",
        "volume_kind": "contracts",
        "volume_unit": "合约",
        "bars": [
            {
                "start": 1587355200000,
                "end": 1587441600000,
                "chart_time": 1587340800000,
                "open": "17.729999542236328",
                "high": "18.260000228881836",
                "low": "-40.31999969482422",
                "close": "-37.630001068115234",
                "volume": "247947",
                "volume_complete": True,
                "complete": True,
            }
        ],
    }
    rows = list(
        csv.DictReader(
            io.StringIO(chart_csv(page, instrument=META["id"], timeframe="D1").decode("utf-8-sig"))
        )
    )
    assert rows[0]["source"] == "yahoo" and rows[0]["raw_symbol"] == "CL=F"
    assert rows[0]["adjustment"] == "supplier" and rows[0]["low"] == "-40.31999969482422"
    assert rows[0]["close"] == "-37.630001068115234" and rows[0]["volume_unit"] == "合约"


def test_yahoo_adapter_error_is_retryable_http_status_not_history_end(database, monkeypatch):
    from alerts.api import app, authenticated
    from fastapi.testclient import TestClient

    monkeypatch.setattr(settings, "yahoo_enabled", True)
    yahoo_catalog.seed()

    def error(*args, **kwargs):
        raise yahoo.YahooError("authentication", "Yahoo 认证或访问被拒绝，请重试")

    monkeypatch.setattr(yahoo_catalog, "chart_metadata", error)
    app.dependency_overrides[authenticated] = lambda: None
    try:
        with TestClient(app) as client:
            response = client.post(
                "/api/charts/data",
                json={
                    "instrument": META["id"],
                    "series_kind": "provider",
                    "timeframe": "D1",
                    "limit": 10,
                },
            )
            assert response.status_code == 503
            assert response.json()["detail"]["status"] == "authentication"
            assert not response.json()["detail"]["history_boundary"]
    finally:
        app.dependency_overrides.pop(authenticated, None)
