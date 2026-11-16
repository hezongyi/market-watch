"""Supplier failures must not erase a maintained watch symbol's identity."""

import pytest
from alerts import market_data, provider_service, provider_yahoo, yahoo_catalog
from alerts.config import settings
from alerts.storage import MarketCatalog


@pytest.mark.parametrize("failure", ["cold_metadata", "expired_metadata", "quote"])
def test_yahoo_failure_keeps_catalog_identity(database, monkeypatch, failure):
    monkeypatch.setattr(settings, "yahoo_enabled", True)
    details = provider_yahoo._metadata({"symbol": "NVDA", "quoteType": "EQUITY", "exchange": "NMS"})
    if failure == "expired_metadata":
        details.update(metadata_observed_at=1, updated_at=1)
    ident = yahoo_catalog._store(details)
    if failure == "cold_metadata":
        with database.begin() as db:
            row = db.get(MarketCatalog, ident)
            row.metadata_json = {key: value for key, value in row.metadata_json.items() if key != "adjustment"}

    def unavailable(*args, **kwargs):
        raise TimeoutError("supplier unavailable")

    monkeypatch.setattr(provider_yahoo, "metadata", unavailable)
    monkeypatch.setattr(provider_service, "yahoo_quote", unavailable)
    row = market_data.quote_snapshot(market_data.QuoteQuery(symbols=["MWP:" + ident]))[0]
    assert row["s"] == "error"
    assert row["v"]["short_name"] == "NVDA"
    assert "英伟达" in row["v"]["description_base"]
    assert "原生 · Yahoo Finance" in row["v"]["description_base"]
    assert row["v"]["exchange"] == "YAHOO"
    assert row["v"]["fetch_status"] == "fetch_failed"
    assert row["v"]["error_evidence"]
    assert "lp" not in row["v"]


@pytest.mark.parametrize("enabled,exists", [(False, True), (True, False)])
def test_invalid_yahoo_identity_still_reports_unavailable(database, monkeypatch, enabled, exists):
    monkeypatch.setattr(settings, "yahoo_enabled", enabled)
    ident = provider_yahoo.stable_id("NVDA")
    if exists:
        yahoo_catalog._store(provider_yahoo._metadata({"symbol": "NVDA", "quoteType": "EQUITY", "exchange": "NMS"}))
    row = market_data.quote_snapshot(market_data.QuoteQuery(symbols=["MWP:" + ident]))[0]
    assert row["s"] == "error"
    assert "short_name" not in row["v"]
    assert "lp" not in row["v"]
