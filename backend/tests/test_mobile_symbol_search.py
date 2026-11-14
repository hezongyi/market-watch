"""Mobile search semantics, paging and write-time identity guards."""

import pytest
from alerts import api
from alerts.advanced_api import preference_id
from alerts.dataset_summaries import summaries
from alerts.history_creation_check import search_catalog
from alerts.history_maintenance import configure
from alerts.instrument_directory import search
from alerts.mobile_symbol_search import identities, validate_additions
from alerts.storage import AdvancedPreference, HistoryVersion, MarketCatalog
from fastapi.testclient import TestClient
from test_market_contracts import identity
from test_market_datasets import register


def preference(db, tickers):
    row = AdvancedPreference(id=preference_id("setting", "mw.watchlists.v1", ""), kind="setting",
        name="mw.watchlists.v1", tool="", content={"value": {"lists": [{"id": "other", "symbols": tickers}]}})
    db.add(row)
    db.flush()
    return row


def test_token_and_across_fields_literal_wildcards_and_aliases(database, monkeypatch):
    from alerts.config import settings
    from alerts.history_catalog import account_scope
    monkeypatch.setattr(settings, "oanda_account_id", "mobile-search")
    monkeypatch.setattr(settings, "oanda_token", "fixture")
    monkeypatch.setattr(settings, "yahoo_enabled", True)
    with database.begin() as db:
        for code in ("XAU_USD", "XAG_USD", "EUR_USD"):
            db.add(MarketCatalog(id="HC:" + code, source="oanda", symbol=code, label="Metal" if code.startswith("X") else "Euro",
                asset_type="METAL" if code.startswith("X") else "CURRENCY", precision=5,
                metadata_json={"history_account_scope": account_scope()}))
        db.add(MarketCatalog(id="YAHOO:NVDA", source="yahoo", symbol="NVDA", label="Nvidia", asset_type="EQUITY",
            precision=2, metadata_json={"exchange": "NMS"}))
        db.flush()
        for query in ("xau oa", "oa XAU", " XAU　 OA  ", "黄金 oa", "金属 oa"):
            rows = search(db, query=query, mobile=True)["items"]
            assert rows and all(row["source"] == "oanda" and row["asset_class"] == "metal" for row in rows)
        assert [row["symbol"] for row in search(db, query="欧元美元 oa", mobile=True)["items"]] == ["EUR_USD"]
        assert search(db, query="xau missing", mobile=True)["total"] == 0
        assert [row["symbol"] for row in search(db, query="黄金 oa", mobile=True)["items"]] == ["XAU_USD"]
        assert [row["symbol"] for row in search(db, query="白银 oa", mobile=True)["items"]] == ["XAG_USD"]
        for query in ("%", "xau %"):
            assert search(db, query=query, mobile=True)["total"] == 0
        assert search(db, query="xau _", mobile=True)["total"] == 1, "underscore is literal, not a wildcard"
        assert search(db, query="股票 yahoo", mobile=True)["total"] == 1
        assert search(db, query="英伟达 yah", mobile=True)["total"] == 1
        assert search(db, query="美股 yahoo", mobile=True)["total"] == 1
        assert search(db, query="xau oa")["total"] == 0, "desktop's default query stays unchanged"
        first = search(db, query="金属 oa", mobile=True, limit=1)
        second = search(db, query="金属 oa", mobile=True, offset=1, limit=1)
        assert first["total"] == second["total"] == 2
        assert first["items"][0]["id"] != second["items"][0]["id"]


def test_watched_native_hidden_globally_before_paging_and_after_removal(database):
    with database.begin() as db:
        for i in range(30):
            db.add(MarketCatalog(id=f"YAHOO:{i}", source="yahoo", symbol=f"S{i:02}", label="Stock", asset_type="EQUITY", precision=2))
        pref = preference(db, [f"MWP:YAHOO:{i}" for i in range(26)])
        result = search(db, source="yahoo", mobile=True, exclude_watch=True, limit=2)
        assert result["total"] == 4 and len(result["items"]) == 2
        assert result["items"][0]["symbol"] == "S26"
        pref.content = {"value": {"lists": []}}
        db.flush()
        assert search(db, source="yahoo", mobile=True, exclude_watch=True)["total"] == 30


def test_stable_history_membership_hides_new_version_but_not_native(database):
    with database.begin() as db:
        register(db)
        from alerts.storage import MarketDataset
        dataset = db.get(MarketDataset, identity().key)
        configure(db, dataset.id, target_start=0, timeframes=["M1"])
        version = HistoryVersion(dataset_id=dataset.id, start=0, end=120000, cursor=120000, status="published", manifest={})
        db.add(version)
        db.flush()
        old_ticker = "MWH:" + version.id
        preference(db, [old_ticker])
        assert identities(db, [old_ticker])[old_ticker] == ("dataset", dataset.id)
        assert summaries(db, mobile=True, exclude_watch=True)["total"] == 0
        assert summaries(db, mobile=True, query="欧元美元 duka")["total"] == 1
        assert search(db, query="eurusd duka", mobile=True, exclude_watch=True)["total"] == 1
        assert search_catalog(db, source="dukascopy", query="eurusd", mobile=True, exclude_existing=True)["total"] == 0
        # Existing archived products also stay excluded.
        from alerts.storage import DatasetMaintenance
        db.get(DatasetMaintenance, dataset.id).archived = True
        db.flush()
        assert search_catalog(db, source="dukascopy", query="eurusd", mobile=True, exclude_existing=True)["total"] == 0


def test_new_duplicates_rejected_but_existing_memberships_and_move_preserved(database):
    old = {"value": {"lists": [{"id": "a", "symbols": ["MWP:YAHOO:NVDA"]}]}}
    duplicate = {"value": {"lists": [*old["value"]["lists"], {"id": "b", "symbols": ["MWP:YAHOO:NVDA"]}]}}
    with database.begin() as db:
        with pytest.raises(ValueError, match="已在自选"):
            validate_additions(db, old, duplicate)
        validate_additions(db, duplicate, duplicate)
        validate_additions(db, duplicate, {"value": {"lists": [
            {"id": "b", "symbols": ["MWP:YAHOO:NVDA"]},
            {"id": "c", "symbols": ["MWP:YAHOO:NVDA"]}]}})
        with pytest.raises(ValueError, match="已在自选"):
            validate_additions(db, duplicate, {"value": {"lists": [*duplicate["value"]["lists"],
                {"id": "c", "symbols": ["MWP:YAHOO:NVDA"]}]}})
        validate_additions(db, old, {"value": {"lists": [{"id": "b", "symbols": ["MWP:YAHOO:NVDA"]}]}})


def test_mobile_search_api_mode_and_write_guard(database):
    with database.begin() as db:
        preference(db, ["MWP:BTCUSDT"])
    api.app.dependency_overrides[api.authenticated] = lambda: "test"
    try:
        with TestClient(api.app) as client:
            rows = client.get("/api/market-data/series/page", params={"kind": "provider", "query": "比特币 bin", "mobile": True, "exclude_watch": True})
            assert rows.status_code == 200 and rows.json()["total"] == 0
            prefs = client.get("/api/advanced-charts/preferences").json()[0]
            prefs["content"]["value"]["lists"].append({"id": "new", "symbols": ["MWP:BTCUSDT"]})
            result = client.post("/api/advanced-charts/preferences/save", json={**prefs, "mobile_unique": True})
            assert result.status_code == 409
    finally:
        api.app.dependency_overrides.clear()


def test_legacy_provider_alias_cannot_reappear_or_be_added_twice(database):
    with database.begin() as db:
        from alerts.storage import Instrument
        legacy = db.get(Instrument, "EURUSD")
        legacy.source, legacy.symbol = "oanda", "EUR_USD"
        db.add(MarketCatalog(id="OANDA:EUR_USD", source="oanda", symbol="EUR_USD", label="Euro",
            asset_type="CURRENCY", precision=5))
        preference(db, ["MWP:EURUSD"])
        db.flush()
        assert search(db, source="oanda", query="eurusd", mobile=True, exclude_watch=True)["total"] == 0
        assert identities(db, ["MWP:EURUSD", "MWP:OANDA:EUR_USD"])["MWP:EURUSD"] == ("provider", "OANDA:EUR_USD")
        with pytest.raises(ValueError, match="已在自选"):
            validate_additions(db, {"value": {"lists": [{"id": "a", "symbols": ["MWP:EURUSD"]}]}},
                {"value": {"lists": [{"id": "a", "symbols": ["MWP:EURUSD", "MWP:OANDA:EUR_USD"]}]}})
