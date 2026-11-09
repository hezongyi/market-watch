"""Legacy directory contracts use current snapshots, paging and account scope."""

import pytest
from alerts import api, catalog_sync, market_data, provider_chart
from alerts.config import settings
from alerts.history_catalog import oanda_catalog_id
from alerts.instrument_directory import search
from alerts.query_errors import QueryError
from alerts.storage import ImportJob, MarketCatalog, MarketDataset, MarketDemand
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import select


@pytest.fixture
def client(database):
    api.app.dependency_overrides[api.authenticated] = lambda: "test"
    try:
        with TestClient(api.app) as client:
            yield client
    finally:
        api.app.dependency_overrides.clear()


@pytest.mark.parametrize("endpoint", ["/catalog/refresh", "/history-catalog/refresh"])
def test_both_refresh_routes_publish_one_scoped_snapshot_and_keep_legacy_identities(
    client, database, monkeypatch, endpoint
):
    monkeypatch.setattr(settings, "oanda_account_id", "compat-account")
    monkeypatch.setattr(settings, "oanda_token", "test-token")
    calls = []

    def fetch():
        calls.append(True)
        return [{"name": symbol, "displayName": symbol, "displayPrecision": 5, "type": "CURRENCY"}
                for symbol in ("EUR_USD", "GBP_CHF")]

    monkeypatch.setattr("alerts.providers.fetch_oanda_catalog", fetch)
    with database.begin() as db:
        db.add(MarketCatalog(id="EURUSD", source="oanda", symbol="EUR_USD", label="Old Euro",
            asset_type="CURRENCY", precision=3, calendar="ny17",
            metadata_json={"name_zh": "我的欧元", "name_zh_origin": "manual", "verified_frames": {"M1": True}}))
        db.add(MarketCatalog(id="OANDA:GBP_USD", source="oanda", symbol="GBP_USD", label="Old Pound",
            asset_type="CURRENCY", precision=5, calendar="ny17"))
    response = client.post("/api/market-data" + endpoint)
    assert response.status_code == 200 and response.json()["count"] == 2
    assert len(calls) == 1
    with database() as db:
        canonical = db.get(MarketCatalog, oanda_catalog_id("EUR_USD"))
        alias = db.get(MarketCatalog, "EURUSD")
        assert alias.available and alias.precision == canonical.precision == 5
        assert alias.updated_at == canonical.updated_at
        assert alias.metadata_json["name_zh"] == "我的欧元"
        assert alias.metadata_json["verified_frames"] == {"M1": True}
        assert not db.get(MarketCatalog, "OANDA:GBP_USD").available
        state, = catalog_sync.statuses(db, "oanda")
        assert state["status"] == "complete" and state["count"] == 2
        assert state["last_success"] == canonical.updated_at
        managed = search(db, source="oanda", managed=True)["items"]
        assert len(managed) == 2 and all(row["id"].startswith("HC:") for row in managed)
        for model in (MarketDataset, MarketDemand, ImportJob):
            assert db.scalar(select(model)) is None
    # New symbols resolve through the scoped snapshot without a second catalog row.
    with database.begin() as db:
        assert db.get(MarketCatalog, "OANDA:GBP_CHF") is None
        assert market_data.resolve(db, "OANDA:GBP_CHF").symbol == "GBP_CHF"
    assert provider_chart.metadata("OANDA:GBP_CHF")["symbol"] == "GBP_CHF"
    monkeypatch.setattr(settings, "oanda_account_id", "other-account")
    with database() as db:
        assert not search(db, source="oanda", query="EURUSD")["items"]
        with pytest.raises(HTTPException, match="当前账户"):
            market_data.resolve(db, "EURUSD")
    with pytest.raises(QueryError, match="当前账户"):
        provider_chart.metadata("EURUSD")


@pytest.mark.parametrize("endpoint", ["/catalog/refresh", "/history-catalog/refresh"])
def test_refresh_failure_keeps_the_same_snapshot_and_sanitized_error(client, database, monkeypatch, endpoint):
    monkeypatch.setattr(settings, "oanda_account_id", "compat-account")
    monkeypatch.setattr(settings, "oanda_token", "test-token")
    monkeypatch.setattr("alerts.providers.fetch_oanda_catalog", lambda: [
        {"name": "EUR_USD", "displayName": "Euro", "displayPrecision": 5, "type": "CURRENCY"}])
    catalog_sync.refresh("oanda")
    with database() as db:
        before = db.get(MarketCatalog, oanda_catalog_id("EUR_USD")).updated_at

    def failed():
        raise TimeoutError("private upstream connection detail")

    monkeypatch.setattr("alerts.providers.fetch_oanda_catalog", failed)
    response = client.post("/api/market-data" + endpoint)
    assert response.status_code == 502 and "private" not in response.text
    with database() as db:
        row = db.get(MarketCatalog, oanda_catalog_id("EUR_USD"))
        assert row.available and row.updated_at == before
        state, = catalog_sync.statuses(db, "oanda")
        assert state["status"] == "failed" and state["last_success"] == before


def test_compatibility_search_uses_paged_order_and_bounded_candidates(client, database, monkeypatch):
    with database.begin() as db:
        db.add_all(MarketCatalog(id="BINANCE:" + symbol, source="binance", symbol=symbol,
            label="Directory compatibility", asset_type="CRYPTO", precision=3, calendar="utc0")
            for symbol in ("COMPAT", "COMPATLONG", "XCOMPAT"))
    calls = []
    original = market_data._provider_series_page

    def bounded(*args, **kwargs):
        calls.append(kwargs["page_size"])
        assert kwargs["page_size"] <= 6
        return original(*args, **kwargs)

    monkeypatch.setattr(market_data, "_provider_series_page", bounded)
    expected = client.get("/api/market-data/series/page", params={
        "kind": "all", "query": "COMPAT", "page_size": 6, "include_total": "false"})
    actual = client.get("/api/market-data/series/search", params={"kind": "all", "query": "COMPAT", "limit": 6})
    assert expected.status_code == actual.status_code == 200
    assert actual.json() == expected.json()["items"]
    assert calls == [6, 6]
    with database() as db:
        ordered = search(db, query="COMPAT")["items"]
    legacy = client.get("/api/market-data/catalog", params={"query": "COMPAT"}).json()
    assert [row["id"] for row in legacy] == [row["id"] for row in ordered]
    assert legacy[0]["symbol"] == "COMPAT"


def test_legacy_source_picker_adapts_the_creation_search_contract(client):
    modern = client.get("/api/market-data/history-catalog/search", params={
        "source": "dukascopy", "query": "USD", "symbol_type": "forex", "offset": 7, "limit": 7})
    legacy = client.get("/api/market-data/history-catalog", params={
        "source": "dukascopy", "query": "USD", "symbol_type": "forex", "page": 2, "page_size": 7})
    assert legacy.status_code == modern.status_code == 200
    assert legacy.json()["items"] == modern.json()["items"]
    assert legacy.json()["total"] == modern.json()["total"]
