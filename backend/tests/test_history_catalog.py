"""Source directory browsing is pure; refresh is explicit and account-scoped."""

import pytest
from alerts.history_catalog import catalog, refresh_oanda, validate_selection
from alerts.storage import MarketCatalog, MarketDataset, MarketDemand
from sqlalchemy import func, select


def test_sdk_catalog_uses_exact_source_code_and_does_not_claim_precision(database):
    with database.begin() as db:
        page = catalog(db, source="dukascopy", query="EURUSD", page_size=10)
        assert page["total"] == 1
        row = page["items"][0]
        assert row["provider_symbol"] == "EUR/USD" and row["asset_class"] == "forex"
        assert row["precision"] is None and row["precision_status"] == "manual_required"
        assert catalog(db, source="dukascopy", query="XAU/USD")["items"][0]["asset_class"] == "metal"
        assert catalog(db, source="dukascopy", query="BTC/USD")["items"][0]["asset_class"] == "crypto"
        assert db.scalar(select(func.count()).select_from(MarketDataset)) == 0
        assert db.scalar(select(MarketDemand)) is None
        validate_selection(db, catalog_id=row["catalog_id"], source="dukascopy", provider_symbol="EUR/USD",
                           logical_symbol="EURUSD", asset_class="forex", precision=5)
        with pytest.raises(ValueError, match="来源目录"):
            validate_selection(db, catalog_id=row["catalog_id"], source="dukascopy", provider_symbol="GBP/USD",
                               logical_symbol="GBPUSD", asset_class="forex", precision=5)


def test_oanda_metadata_refresh_is_explicit_and_scope_does_not_leak_old_account(database, monkeypatch):
    from alerts import history_catalog, providers

    monkeypatch.setattr(history_catalog.settings, "oanda_account_id", "catalog-test-account")
    monkeypatch.setattr(history_catalog.settings, "oanda_token", "test-token")
    calls = []
    def fetch():
        calls.append(True)
        return [{"name": "EUR_USD", "displayName": "Euro", "displayPrecision": 5, "type": "CURRENCY"},
                {"name": "XAU_USD", "displayName": "Gold", "displayPrecision": 3, "type": "METAL"}]
    monkeypatch.setattr(providers, "fetch_oanda_catalog", fetch)
    with database.begin() as db:
        db.add(MarketCatalog(id="legacy", source="oanda", symbol="EUR_USD", label="legacy",
                            asset_type="CURRENCY", precision=5, calendar="ny17"))
        assert catalog(db, source="oanda")["total"] == 0 and calls == []
    assert refresh_oanda()["count"] == 2 and len(calls) == 1
    with database.begin() as db:
        page = catalog(db, source="oanda", query="EUR")
        row = page["items"][0]
        assert row["precision"] == 5 and row["asset_class"] == "forex"
        assert db.get(MarketCatalog, "legacy").label == "legacy"
        empty_search = catalog(db, source="oanda", query="%")
        assert empty_search["total"] == 0 and not empty_search["requires_refresh"]
        assert db.scalar(select(MarketDemand)) is None
        assert db.scalar(select(MarketDataset)) is None
        validate_selection(db, catalog_id=row["catalog_id"], source="oanda", provider_symbol="EUR_USD",
                           logical_symbol="EURUSD", asset_class="forex", precision=5)
        with pytest.raises(ValueError, match="精度"):
            validate_selection(db, catalog_id=row["catalog_id"], source="oanda", provider_symbol="EUR_USD",
                               logical_symbol="EURUSD", asset_class="forex", precision=3)
    monkeypatch.setattr(history_catalog.settings, "oanda_account_id", "different-account")
    with database.begin() as db:
        page = catalog(db, source="oanda")
        assert page["total"] == 0 and page["requires_refresh"]
        with pytest.raises(ValueError, match="当前账户"):
            validate_selection(db, catalog_id=row["catalog_id"], source="oanda", provider_symbol="EUR_USD",
                               logical_symbol="EURUSD", asset_class="forex", precision=5)


def test_history_catalogue_does_not_enter_native_routes_or_get_disabled_by_legacy_refresh(database, monkeypatch):
    from alerts import api, market_data, provider_chart
    from alerts.config import settings
    from fastapi import HTTPException
    from fastapi.testclient import TestClient

    ident = "HC:" + "a" * 36
    with database.begin() as db:
        db.add(MarketCatalog(id=ident, source="oanda", symbol="EUR_USD", label="Euro",
            asset_type="CURRENCY", precision=5, calendar="ny17",
            metadata_json={"history_account_scope": "old-account"}))
    monkeypatch.setattr(market_data, "fetch_oanda_catalog", lambda: [
        {"name": "EUR_USD", "displayName": "Euro", "displayPrecision": 5, "type": "CURRENCY"}])
    market_data.refresh_catalog()
    with database.begin() as db:
        assert db.get(MarketCatalog, ident).available
        with pytest.raises(HTTPException, match="自建来源目录"):
            market_data.resolve(db, ident)
    with pytest.raises(HTTPException, match="自建来源目录"):
        provider_chart.metadata(ident)
    monkeypatch.setattr(settings, "yahoo_enabled", False)
    assert ident not in {row["id"] for row in market_data.instrument_catalog()}
    api.app.dependency_overrides[api.authenticated] = lambda: "test"
    try:
        with TestClient(api.app) as client:
            result = client.get("/api/market-data/center/platform", params={"source": "oanda"})
            assert result.status_code == 200
            assert result.json()["total"] == 1
            assert all(row["id"] != ident for row in result.json()["items"])
    finally:
        api.app.dependency_overrides.clear()
