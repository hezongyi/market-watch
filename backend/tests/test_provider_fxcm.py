"""FXCM local directory, native intervals and existing shared cache integration."""

import json

import pytest
from alerts import fxcm_history, history_catalog
from alerts import provider_fxcm as provider
from alerts.storage import MarketCatalog, Preference, ProviderBar
from sqlalchemy import func, select
from test_fxcm_history import fxcm_config as _fxcm_config

fxcm_config = _fxcm_config


def directory(database, monkeypatch):
    monkeypatch.setattr(fxcm_history.FxcmHistory, "catalog", lambda _: [
        {"symbol": "EUR/USD", "digits": 5, "instrument_type": 1},
        {"symbol": "XAU/USD", "digits": 2, "instrument_type": 5}])
    monkeypatch.setattr(fxcm_history.FxcmHistory, "timeframes", lambda _: {f: 300 for f in fxcm_history.FRAMES})
    assert history_catalog.refresh_fxcm()["count"] == 2
    with database() as db:
        return list(db.scalars(select(MarketCatalog).where(MarketCatalog.source == "fxcm")))


def test_directory_search_is_local_and_account_scoped(database, fxcm_config, monkeypatch):
    from alerts.platform_catalog import catalog
    rows = directory(database, monkeypatch)
    monkeypatch.setattr(fxcm_history.FxcmHistory, "catalog", lambda _: pytest.fail("search performed IO"))
    with database() as db:
        result = catalog(db, source="fxcm", query="XAUUSD")
        assert result["total"] == 1 and result["items"][0]["precision"] == 2
        assert db.get(Preference, "upstream_slots:fxcm") is None
    old = provider.metadata(rows[0].id)
    secret, _ = fxcm_config
    secret.write_text(json.dumps({"username": "different-fixture", "password": "fixture"}))
    with database() as db:
        assert catalog(db, source="fxcm")["total"] == 0
    with pytest.raises(Exception) as error:
        provider.metadata(old["id"])
    assert error.value.status_code == 404


@pytest.mark.parametrize("kind", ["all", "provider"])
@pytest.mark.parametrize("query", ["", "EURUSD"])
def test_native_symbol_search_accepts_unmapped_fxcm_directory(
    database, fxcm_config, monkeypatch, kind, query
):
    from alerts import api, market_data
    from fastapi.testclient import TestClient

    directory(database, monkeypatch)
    # Keep unrelated providers offline, but exercise the real FXCM catalog,
    # provider merge, ranking and authenticated native-search HTTP endpoint.
    monkeypatch.setattr(market_data, "instrument_catalog", lambda *a, **k: [])
    monkeypatch.setattr(
        fxcm_history.FxcmHistory, "catalog", lambda _: pytest.fail("search performed broker IO")
    )
    api.app.dependency_overrides[api.authenticated] = lambda: "test"
    try:
        with TestClient(api.app) as client:
            response = client.get(
                "/api/market-data/series/page",
                params={"kind": kind, "query": query, "page_size": 50},
            )
            assert response.status_code == 200
            rows = response.json()["items"]
            assert rows and all(row["source"] == "fxcm" for row in rows)
            assert all(row["logical_symbol"] is None for row in rows)
            assert all(row["ticker"].startswith("MWP:FXCM:") for row in rows)
            if query:
                assert [row["symbol"] for row in rows] == ["EUR/USD"]
    finally:
        api.app.dependency_overrides.clear()


def test_available_catalog_identity_wins_over_retired_same_symbol(database, fxcm_config, monkeypatch):
    from alerts.platform_catalog import catalog

    with database.begin() as db:
        db.add(MarketCatalog(id="FXCM:" + "0" * 36, source="fxcm", symbol="EUR/USD",
            label="retired acceptance identity", asset_type="CURRENCY", precision=5, available=False,
            metadata_json={"history_account_scope": fxcm_history.account_scope()}))
    directory(database, monkeypatch)
    with database() as db:
        result = catalog(db, source="fxcm", query="EURUSD")
    assert result["total"] == 1
    assert result["items"][0]["available"]
    assert len(result["items"][0]["id"]) <= 40


def test_native_frame_phase_and_completion_are_explicit(database, fxcm_config, monkeypatch):
    rows = directory(database, monkeypatch)
    meta = provider.metadata(rows[0].id)
    starts = [21 * 3600000, 45 * 3600000]
    class Adapter:
        def bars(self, symbol, frame, start, end, digits, **kwargs):
            assert frame == "D1" and kwargs["scope"] == meta["account_scope"]
            return [{"start": at, "open": "1.1", "high": "1.2", "low": "1",
                     "close": "1.1", "volume": "2"} for at in starts]
    monkeypatch.setattr(provider, "now_ms", lambda: starts[-1] + 24 * 3600000)
    page = provider.native_page(meta, "D1", 100 * 3600000, 2, client=Adapter())
    assert page["bars"][0]["end"] == starts[1]
    assert [row["chart_time"] for row in page["bars"]] == starts
    assert page["bars"][0]["complete"] and not page["bars"][1]["complete"]
    assert all(row["source_confirmed"] is None for row in page["bars"])
    assert page["has_more"] and not page["history_boundary"]
    with pytest.raises(ValueError):
        provider.native_page(meta, "H12", 100000, 1, client=Adapter())


def native_cache_contract(database, fxcm_config, monkeypatch):
    from alerts import api, provider_cache
    from fastapi.testclient import TestClient
    rows = directory(database, monkeypatch)
    calls = []
    def bars(*args, **kwargs):
        calls.append((args, kwargs))
        return [{"start": 1699999920000, "open": "1.10000", "high": "1.20000",
                 "low": "1.00000", "close": "1.11000", "volume": "211"}]
    monkeypatch.setattr(provider._ADAPTER, "bars", bars)
    monkeypatch.setattr(provider_cache, "revalidate_history", lambda *a, **k: None)
    api.app.dependency_overrides[api.authenticated] = lambda: "test"
    try:
        with TestClient(api.app) as client:
            body = {"instrument": rows[0].id, "series_kind": "provider", "timeframe": "M1",
                    "before": 1699999980000, "limit": 1}
            for _ in range(2):
                response = client.post("/api/charts/data", json=body)
                assert response.status_code == 200, response.text
                assert response.json()["bars"][0]["close"] == "1.11000"
                assert response.json()["volume_kind"] == "tick_count"
        assert len(calls) == 1
        with database() as db:
            assert db.scalar(select(func.count()).select_from(ProviderBar)) == 1
    finally:
        api.app.dependency_overrides.clear()
        provider.close_session()


def test_existing_http_cache_deduplicates_fxcm(database, fxcm_config, monkeypatch):
    native_cache_contract(database, fxcm_config, monkeypatch)


def test_catalog_identity_opens_and_roundtrips_native_workspace(database, fxcm_config, monkeypatch):
    from alerts import api
    from alerts.chart_series import decode
    from fastapi.testclient import TestClient

    instrument = directory(database, monkeypatch)[0]
    ticker = "MWP:" + instrument.id
    assert decode(ticker.upper()) == (instrument.id, "provider")
    api.app.dependency_overrides[api.authenticated] = lambda: "test"
    try:
        with TestClient(api.app) as client:
            response = client.post("/api/advanced-charts/workspaces", json={
                "name": "FXCM directory to chart", "symbol": ticker})
            assert response.status_code == 200, response.text
            workspace = response.json()
            assert workspace["document"]["symbol"] == ticker
            resolved = client.post("/api/market-data/resolve", json={
                "instrument": instrument.id.upper(), "series_kind": "provider", "timeframe": "H1"})
            assert resolved.status_code == 200, resolved.text
            saved = client.post("/api/advanced-charts/native-charts/save", json={
                "id": workspace["id"], "name": workspace["name"], "revision": workspace["revision"],
                "symbol": ticker, "resolution": "60", "content": json.dumps({"charts": [{"symbol": ticker}]})})
            assert saved.status_code == 200, saved.text
            assert saved.json()["series_kind"] == "provider"
    finally:
        api.app.dependency_overrides.clear()
