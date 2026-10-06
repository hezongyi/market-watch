"""Native SDK requests preserve exact source periods, independent of managed M1."""

import json

import httpx
import pytest
from alerts import provider_dukascopy as provider
from alerts.chart_series import decode, encode
from alerts.storage import Bar, MarketDemand
from sqlalchemy import select


@pytest.mark.parametrize("frame", provider.FRAMES)
def test_native_sdk_exact_period_and_exclusive_backward_pagination(frame):
    meta = provider.metadata(provider.stable_id("EUR/USD"))
    calls = []
    def handle(request):
        calls.append(request)
        params = request.url.params
        assert params["interval"] == provider.INTERVALS[frame]
        assert params["time_direction"] == "P" and params["offer_side"] == "B"
        assert params["splits"] == params["stocks"] == "true"
        before = int(params["last_update"]) + 1
        # Avoid float roundtrips when writing the real JSONP source payload.
        payload = '[[%d,1.123456789012345678,1.2,1.0,1.11,12.340000001]]' % (before - 60000)
        return httpx.Response(200, text=params["jsonp"] + "(" + payload + ");")
    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        page = provider.native_page(meta, frame, 1700000000000, 2, client=client)
        second = provider.native_page(meta, frame, page["bars"][0]["chart_time"], 2, client=client)
    assert len(calls) == 2
    assert page["bars"][0]["open"] == "1.123456789012345678"
    assert page["bars"][0]["volume"] == "12.340000001"
    assert page["bars"][0]["source_confirmed"] is None
    assert second["bars"][-1]["start"] < page["bars"][0]["start"]
    assert not page["history_boundary"] and page["has_more"]


def test_native_catalog_source_identity_never_registers_or_creates_demand(database):
    from alerts.market_data import instrument_catalog
    from alerts.provider_chart import metadata

    row = next(r for r in instrument_catalog("EURUSD") if r["source"] == "dukascopy")
    assert row["series_kinds"] == ["provider"]
    ticker = encode(row["id"], "provider")
    assert decode(ticker.upper()) == (row["id"], "provider")
    assert metadata(row["id"])["calendar"] == provider.CALENDAR
    with database() as db:
        assert db.scalar(select(Bar)) is None
        assert db.scalar(select(MarketDemand)) is None


def test_empty_native_response_is_not_earliest_history():
    meta = provider.metadata(provider.stable_id("EUR/USD"))
    with httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200,
            text=r.url.params["jsonp"] + "([]);"))) as client:
        page = provider.native_page(meta, "M1", 1000000, 20, client=client)
    assert page["bars"] == [] and page["coverage"] == []
    assert not page["history_boundary"] and page["has_more"]


def test_source_over_return_is_validated_then_bounded_without_resampling():
    raw = [[180000, 1, 2, 1, 1, 12], [120000, 1, 2, 1, 1, 13], [60000, 1, 2, 1, 1, 14]]
    with httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200,
            text=r.url.params["jsonp"] + "(" + json.dumps(raw) + ");"))) as client:
        page = provider.native_page(provider.metadata(provider.stable_id("EUR/USD")), "M1", 240000, 2, client=client)
    assert [row["start"] for row in page["bars"]] == [120000, 180000]
    assert [row["volume"] for row in page["bars"]] == ["13", "12"]
    assert page["request_evidence"]["returned"] == 3
    assert page["request_evidence"]["retained"] == 2
    assert page["coverage"] == [[120000, 240000]]


@pytest.mark.parametrize("payload", [[[1, 1]], [[1, 1, 2, 0, 1, 1], [1, 1, 2, 0, 1, 1]],
    [[1, 1, 0, 2, 1, 1]], {"error": "bad"}])
def test_malformed_native_page_is_not_success(payload):
    with httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200,
            text=r.url.params["jsonp"] + "(" + json.dumps(payload) + ");"))) as client:
        with pytest.raises(ValueError):
            provider.native_page(provider.metadata(provider.stable_id("EUR/USD")), "M1", 1000000, 2, client=client)


def test_month_boundary_and_elapsed_status_are_not_source_confirmation(monkeypatch):
    from alerts.storage import instant, ms

    start = ms(instant(0).replace(year=2024, month=2, day=1))
    end = ms(instant(0).replace(year=2024, month=3, day=1))
    assert provider.interval_end(start, "MN") == end
    assert provider.interval_end(ms(instant(0).replace(year=2024, month=12, day=1)), "MN") == ms(
        instant(0).replace(year=2025, month=1, day=1))
    meta = provider.metadata(provider.stable_id("EUR/USD"))
    with httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200,
            text=r.url.params["jsonp"] + f"([[{start},1,2,1,1,12]]);"))) as client:
        monkeypatch.setattr(provider, "now_ms", lambda: end - 1)
        partial = provider.native_page(meta, "MN", end, 1, client=client)["bars"][0]
        monkeypatch.setattr(provider, "now_ms", lambda: end)
        closed = provider.native_page(meta, "MN", end, 1, client=client)["bars"][0]
    assert not partial["time_closed"] and not partial["complete"]
    assert closed["time_closed"] and closed["complete"]
    assert partial["source_confirmed"] is closed["source_confirmed"] is None


def test_rate_limit_persists_cooldown_without_retry(database):
    from alerts.storage import Preference, now_ms

    calls = []
    def rate_limited(request):
        calls.append(request)
        return httpx.Response(429, headers={"Retry-After": "40"})
    with httpx.Client(transport=httpx.MockTransport(rate_limited)) as client:
        with pytest.raises(httpx.HTTPStatusError):
            provider.native_page(provider.metadata(provider.stable_id("EUR/USD")), "M1", 1000000, 2, client=client)
    assert len(calls) == 1
    with database() as db:
        assert db.get(Preference, "upstream_slots:dukascopy").value["cooldown_until"] >= now_ms() + 39000


def test_source_jsonp_bot_block_persists_shared_cooldown(database):
    from alerts.market_resources import acquire
    from alerts.storage import Preference, now_ms

    with httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200,
            text=r.url.params["jsonp"] + '({"error":"Too Many Requests (Bot blocked)"});'))) as client:
        with pytest.raises(provider.NativeRateLimited):
            provider.native_page(provider.metadata(provider.stable_id("EUR/USD")), "H4", 1000000, 180, client=client)
    with database() as db:
        assert db.get(Preference, "upstream_slots:dukascopy").value["cooldown_until"] > now_ms()
    assert acquire("dukascopy", "chart", now_ms()) is None
    assert acquire("dukascopy", "history", now_ms()) is None


def test_history_and_native_chart_share_one_source_request_budget(database):
    from alerts.market_resources import acquire, release

    token = acquire("dukascopy", "chart", 100000)
    assert token
    assert acquire("dukascopy", "history", 100000) is None
    release("dukascopy", token)
    assert acquire("dukascopy", "history", 100999) is None
    assert acquire("dukascopy", "history", 101000)


def test_platform_catalog_pages_all_sdk_symbols_without_supplier_io(database):
    from alerts.platform_catalog import catalog

    with database() as db:
        first = catalog(db, source="dukascopy", page_size=100)
        rows = []
        for page in range(1, (first["total"] + 99) // 100 + 1):
            rows += catalog(db, source="dukascopy", page=page, page_size=100)["items"]
        assert len(rows) == len({row["id"] for row in rows}) == len(provider.catalog())
        assert len(rows) > 250
        eur = catalog(db, source="dukascopy", query="eurusd")["items"]
        assert len(eur) == 1 and eur[0]["history_precision"] is None
        assert eur[0]["precision"] == 8
        assert db.scalar(select(MarketDemand)) is None
        assert db.scalar(select(Bar)) is None


def native_http_contract(factory, monkeypatch):
    from alerts import api, provider_cache, provider_chart
    from alerts.storage import Instrument, MarketDataset, ProviderBar
    from fastapi.testclient import TestClient
    from sqlalchemy import func

    symbol = provider.stable_id("EUR/USD")
    calls = []
    def handle(request):
        calls.append(request)
        before = int(request.url.params["last_update"]) + 1
        rows = '[[%d,1.123456789012345678,1.2,1,1.11,12.340000001]]' % (before - 60000)
        return httpx.Response(200, text=request.url.params["jsonp"] + "(" + rows + ");")
    api.app.dependency_overrides[api.authenticated] = lambda: "test"
    monkeypatch.setattr(provider_cache, "revalidate_history", lambda *a, **k: None)
    try:
        with httpx.Client(transport=httpx.MockTransport(handle)) as transport:
            monkeypatch.setattr("alerts.provider_transport.pooled_client", lambda _: transport)
            with TestClient(api.app) as client:
                with factory() as db:
                    original = db.scalar(select(func.count()).select_from(Instrument))
                page = client.get("/api/market-data/center/platform?source=dukascopy&query=EURUSD").json()
                assert page["total"] == 1 and calls == []
                workspace = client.post("/api/advanced-charts/workspaces", json={
                    "name": "native-test", "symbol": "MWP:" + symbol.upper()})
                assert workspace.status_code == 200
                assert workspace.json()["document"]["symbol"] == "MWP:" + symbol
                assert client.post("/api/advanced-charts/workspaces", json={
                    "name": "bad", "symbol": "invalid/ticker"}).status_code == 422
                assert calls == []
                body = {"instrument": symbol, "series_kind": "provider", "timeframe": "M1",
                        "before": 1700000000000, "limit": 1}
                first = client.post("/api/charts/data", json=body)
                assert first.status_code == 200, first.text
                second = client.post("/api/charts/data", json=body)
                assert second.status_code == 200 and len(calls) == 1
                for response in (first, second):
                    bar = response.json()["bars"][0]
                    assert bar["open"] == "1.123456789012345678"
                    assert bar["volume"] == "12.340000001" and bar["source_confirmed"] is None
                    assert not response.json()["history_boundary"]
                with factory() as db:
                    assert db.scalar(select(func.count()).select_from(ProviderBar)) == 1
                    assert db.scalar(select(func.count()).select_from(Instrument)) == original
                    assert db.scalar(select(Bar)) is None and db.scalar(select(MarketDataset)) is None
                    assert db.scalar(select(MarketDemand)) is None
    finally:
        api.app.dependency_overrides.clear()
        provider_chart.close_clients()


def test_native_http_cache_identity_and_exact_prices(database, monkeypatch):
    native_http_contract(database, monkeypatch)


def test_malformed_upstream_http_reports_unavailable_not_empty(database, monkeypatch):
    from alerts import api, provider_chart
    from fastapi.testclient import TestClient

    def bad_page(*args, **kwargs):
        raise provider.NativeDataError("invalid supplier payload")
    monkeypatch.setattr(provider_chart, "native_page", bad_page)
    api.app.dependency_overrides[api.authenticated] = lambda: "test"
    try:
        with TestClient(api.app) as client:
            response = client.post("/api/charts/data", json={"instrument": provider.stable_id("EUR/USD"),
                "series_kind": "provider", "timeframe": "M1", "before": 1700000000000, "limit": 1})
        assert response.status_code == 503
        assert response.json()["detail"]["history_boundary"] is False
        assert response.json()["detail"]["status"] == "invalid_data"
    finally:
        api.app.dependency_overrides.clear()
