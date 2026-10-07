"""Native configuration reaches transport and stays separate from managed inputs."""

from copy import deepcopy
from datetime import datetime
from decimal import Decimal

import httpx
import pytest
from alerts import api, native_series, provider_cache, provider_chart
from alerts.config import settings
from alerts.native_series import DEFAULTS, OandaParameters, chart_label, interval_end
from alerts.storage import MarketCatalog, MarketDemand, ProviderDataset, SourceSeries
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import func, select


@pytest.fixture
def native_catalog(database):
    with database.begin() as db:
        db.add(MarketCatalog(id="OANDA:EUR_USD", source="oanda", symbol="EUR_USD", label="EURUSD",
            calendar="ny17", asset_type="CURRENCY", precision=5, available=True, metadata_json={}, updated_at=0))
    return database


def stamp(value):
    return int(datetime.fromisoformat(value).timestamp() * 1000)


@pytest.mark.parametrize("values", [{"price": "BA"}, {"smooth": "true"}, {"dailyAlignment": True},
    {"dailyAlignment": 24}, {"alignmentTimezone": "bad/timezone"}, {"weeklyAlignment": "bad"}, {"extra": 1}])
def test_invalid_supplier_parameters_rejected(values):
    with pytest.raises(ValidationError):
        OandaParameters.model_validate(values)


def test_authenticated_registration_is_immutable_idempotent_and_demand_free(native_catalog, monkeypatch):
    database = native_catalog
    monkeypatch.setattr(settings, "oanda_account_id", "native-test-account")
    with TestClient(api.app) as client:
        body = {"instrument": "OANDA:EUR_USD", "parameters": {**DEFAULTS, "price": "M", "smooth": True}}
        assert client.post("/api/charts/provider/configure", json=body).status_code == 401
        api.app.dependency_overrides[api.authenticated] = lambda: "test"
        try:
            default = client.post("/api/charts/provider/configure", json={**body, "parameters": DEFAULTS})
            assert default.status_code == 200
            assert default.json()["ticker"] == "MWP:OANDA:EUR_USD"
            created = client.post("/api/charts/provider/configure", json=body)
            assert created.status_code == 200, created.text
            data = created.json()
            assert data == client.post("/api/charts/provider/configure", json=body).json()
            assert data["metadata"]["basis"] == "mid"
            assert data["metadata"]["native_identity"]["parameters"] == body["parameters"]
            ticker = data["ticker"][4:]
            assert provider_chart.metadata(ticker.upper())["id"] == ticker
            assert native_series.register(data["metadata"], DEFAULTS)["id"] == "OANDA:EUR_USD"
            assert native_series.register(data["metadata"], body["parameters"])["native_identity"] == data["metadata"]["native_identity"]
            with pytest.raises(ValueError, match="数据中心"):
                provider_chart.earliest_m1(data["metadata"])
            resolved = client.post("/api/market-data/resolve", json={"instrument": ticker,
                "series_kind": "provider", "timeframe": "M1"})
            assert resolved.json() == data["metadata"]
            monkeypatch.setattr(settings, "oanda_account_id", "another-native-account")
            assert client.post("/api/market-data/resolve", json={"instrument": ticker,
                "series_kind": "provider", "timeframe": "M1"}).status_code == 422
        finally:
            api.app.dependency_overrides.clear()
    with database.begin() as db:
        assert db.scalar(select(func.count()).select_from(SourceSeries)) == 1
        assert db.scalar(select(func.count()).select_from(ProviderDataset)) == 0
        assert db.scalar(select(func.count()).select_from(MarketDemand)) == 0
    with pytest.raises(ValueError, match="immutable"):
        with database.begin() as db:
            db.scalar(select(SourceSeries)).identity = {}


@pytest.mark.parametrize("delta", [{"price": "A"}, {"price": "M"}, {"smooth": True},
    {"dailyAlignment": 0}, {"alignmentTimezone": "UTC"}, {"weeklyAlignment": "Monday"}])
def test_parameter_isolation_and_original_native_ohlc(native_catalog, monkeypatch, delta):
    monkeypatch.setattr(settings, "oanda_token", "test-only")
    meta = provider_chart.metadata("OANDA:EUR_USD")
    before = stamp("2026-10-02T00:00:00+00:00")
    configured = native_series.register(meta, {**DEFAULTS, **delta})
    assert provider_cache.identity(meta, "D1") != provider_cache.identity(configured, "D1")
    native = configured["native_parameters"]

    def handle(request):
        for key, value in native.items():
            assert request.url.params[key] == str(value).lower() if isinstance(value, bool) else request.url.params[key] == str(value)
        assert request.url.params["granularity"] == "D"
        return httpx.Response(200, json={"candles": [{"time": "1790636400", "complete": True,
            "volume": 101, {"B": "bid", "A": "ask", "M": "mid"}[native["price"]]:
            {"o": "1.123456789", "h": "2.11", "l": "1.01", "c": "1.99"}}]})

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        result = provider_chart.native_page(configured, "D1", before, 3, client=client)
    bar = result["bars"][0]
    assert (bar["open"], bar["high"], bar["low"], bar["close"], bar["volume"]) == (
        "1.123456789", "2.11", "1.01", "1.99", "101")


def test_default_cache_identity_is_unchanged(native_catalog):
    meta = provider_chart.metadata("OANDA:EUR_USD")
    legacy = deepcopy(meta)
    del legacy["native_parameters"]
    assert provider_cache.identity(meta, "D1") == provider_cache.identity(legacy, "D1")
    assert native_series.register(meta, DEFAULTS)["id"] == meta["id"]


def test_custom_quote_uses_same_native_session_and_price_basis(native_catalog, monkeypatch):
    values = {**DEFAULTS, "price": "A", "dailyAlignment": 0, "alignmentTimezone": "UTC"}
    meta = native_series.register(provider_chart.metadata("OANDA:EUR_USD"), values)
    boundary = stamp("2026-10-07T00:00:00+00:00")

    def cached(received, frame, before, count, **kwargs):
        assert received["native_parameters"] == values
        assert frame == "D1" and before == boundary
        return {"bars": [
            {"complete": True, "end": boundary, "close": "1.123456789"},
            {"complete": False, "end": boundary + 86400000, "close": "9.9"}]}

    monkeypatch.setattr(provider_chart, "cached_page", cached)
    assert provider_chart.quote_previous_close(meta, {"start": boundary + 120000}) == Decimal("1.123456789")


def test_custom_alignment_does_not_bypass_native_alert_calendar_gate(native_catalog):
    from alerts.chart_alert_api import CapabilityQuery, capabilities

    values = {**DEFAULTS, "weeklyAlignment": "Friday"}
    meta = native_series.register(provider_chart.metadata("OANDA:EUR_USD"), values)
    report = capabilities(CapabilityQuery(instrument=meta["id"], series_kind="provider", timeframe="D1"))
    assert report["sources"][0]["available"] is False
    assert "日历" in report["sources"][0]["reason"]


@pytest.mark.parametrize("opening,ending", [
    ("2026-03-07T22:00:00+00:00", "2026-03-08T21:00:00+00:00"),
    ("2026-10-31T21:00:00+00:00", "2026-11-01T22:00:00+00:00"),
])
def test_native_daily_ends_follow_local_dst(opening, ending):
    assert interval_end(stamp(opening), "D1", DEFAULTS) == stamp(ending)


@pytest.mark.parametrize("opening,ending,label,values", [
    ("2026-09-30T21:00:00+00:00", "2026-10-31T21:00:00+00:00", "2026-10-01T00:00:00+00:00", DEFAULTS),
    ("2026-10-31T21:00:00+00:00", "2026-11-30T22:00:00+00:00", "2026-11-01T00:00:00+00:00", DEFAULTS),
    ("2024-01-31T22:00:00+00:00", "2024-02-29T22:00:00+00:00", "2024-02-01T00:00:00+00:00", DEFAULTS),
    ("2026-09-30T00:00:00+00:00", "2026-10-31T00:00:00+00:00", "2026-10-01T00:00:00+00:00",
        {**DEFAULTS, "dailyAlignment": 0, "alignmentTimezone": "UTC"}),
])
def test_supplier_month_boundaries_are_not_local_reaggregation(opening, ending, label, values):
    assert interval_end(stamp(opening), "MN", values) == stamp(ending)
    assert chart_label(stamp(opening), "MN", values) == stamp(label)


def test_h4_dst_short_final_bucket_and_session_quote_boundary():
    assert interval_end(stamp("2026-03-08T18:00:00+00:00"), "H4", DEFAULTS) == stamp("2026-03-08T21:00:00+00:00")
    assert interval_end(stamp("2026-11-01T17:00:00+00:00"), "H4", DEFAULTS) == stamp("2026-11-01T22:00:00+00:00")
    assert native_series.session_start(stamp("2026-03-09T20:30:00+00:00"), DEFAULTS) == stamp("2026-03-08T21:00:00+00:00")
    assert chart_label(stamp("2026-09-30T00:00:00+00:00"), "D1",
        {**DEFAULTS, "dailyAlignment": 0, "alignmentTimezone": "UTC"}) == stamp("2026-09-30T00:00:00+00:00")
