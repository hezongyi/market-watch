import json

import pytest
from alerts import api as api_module
from alerts import live_pricing as live
from alerts.storage import MarketDataset, MarketDemand, Preference
from fastapi.testclient import TestClient
from sqlalchemy import select
from test_live_pricing import running as _running

running = _running


def test_live_reads_require_authentication(database):
    with TestClient(api_module.app) as client:
        assert client.get("/api/market-data/live").status_code == 401
        assert client.get("/api/market-data/live/metrics/unknown").status_code == 401
        assert client.post("/api/market-data/live/demand", json={}).status_code == 401


def test_snapshot_hides_uncollected_catalog_and_browser_demands_extend_shared_union(running):
    factory, _, _, _ = running
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            assert {row["logical_symbol"] for row in client.get("/api/market-data/live").json()} == {"EURUSD", "XAUUSD"}
            with factory.begin() as db:
                dataset = db.scalar(select(MarketDataset).where(MarketDataset.logical_symbol == "GBPUSD"))
                key = dataset.id
            body = {"client": "browser-one", "dataset_id": key}
            assert client.post("/api/market-data/live/demand", json=body).status_code == 200
            assert client.post("/api/market-data/live/demand", json=body).status_code == 200
            assert client.post("/api/market-data/live/demand", json=body | {"dataset_id": "a" * 64}).status_code == 422
            assert client.get(f"/api/market-data/live/metrics/{key}?since=-1").status_code == 422
        with factory.begin() as db:
            assert len(list(db.scalars(select(MarketDemand)))) == 1
        assert set(live.desired_datasets("test-account")) == {"EUR_USD", "XAU_USD", "GBP_USD"}
    finally:
        api_module.app.dependency_overrides.clear()


def test_registered_source_identity_is_available_and_saved_in_chart_workspace(running):
    _, _, _, identities = running
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            catalog = client.get("/api/charts/catalog").json()
            instrument = next(row["id"] for row in catalog["managed_sources"] if row["symbol"] == "EURUSD")
            workspace = client.post("/api/charts/workspaces", json={"name": "source chart"}).json()
            workspace["document"]["panels"][0]["instrument"] = instrument
            saved = client.post(f'/api/charts/workspaces/{workspace["id"]}/save', json={
                "name": workspace["name"], "revision": workspace["revision"], "document": workspace["document"]})
            assert saved.status_code == 200
            assert saved.json()["document"]["panels"][0]["instrument"] == instrument
            instruments = client.get("/api/instruments").json()
            live_row = next(row for row in instruments if row["id"] == instrument)
            assert live_row["dataset_identity"]["environment"] == "practice"
            assert live_row["logical_symbol"] == "EURUSD"
            metrics = client.get(f'/api/market-data/live/metrics/{identities["EUR_USD"].key}')
            assert metrics.status_code == 200
    finally:
        api_module.app.dependency_overrides.clear()


def test_live_snapshot_reports_shared_rest_cooldown_without_changing_quote_readiness(running):
    factory, ownership, epoch, identities = running
    identity = identities["EUR_USD"]
    from test_live_pricing import candles, quote

    live.commit_confirmation(ownership, epoch, candles(identity), now=125000)
    live.publish_event(ownership, epoch, quote(identity, epoch), identities, now=125000)
    with factory.begin() as db:
        db.add(Preference(key="upstream_slots:oanda", value={"cooldown_until": 155000.5}))
        db.add(Preference(key="upstream_slots:dukascopy", value={"cooldown_until": 999999}))
    rows = live.snapshots(now=125000)
    assert {row["cooldown_until"] for row in rows} == {155001}
    eur = next(row for row in rows if row["dataset_id"] == identity.key)
    assert eur["quote_ready"] and eur["candle_ready"]
    assert eur["quality"] == "healthy"
    assert all(row["cooldown_until"] is None for row in live.snapshots(now=155001))


def test_snapshot_signature_detects_cooldown_change_without_new_quote_or_epoch():
    from alerts.live_api import snapshot_signature

    row = {"dataset_id": "dataset", "revision": 2, "quality": "healthy", "cooldown_until": None}
    assert snapshot_signature([row]) != snapshot_signature([row | {"cooldown_until": 200000}])
    assert snapshot_signature([row]) == snapshot_signature([dict(row)])


@pytest.mark.asyncio
async def test_sse_publishes_cooldown_start_and_expiry_with_unchanged_revision(monkeypatch):
    from alerts import live_api

    deadlines = iter((None, 200000, None))
    monkeypatch.setattr(live_api, "snapshots", lambda: [{"dataset_id": "dataset", "revision": 2,
        "quality": "healthy", "cooldown_until": next(deadlines)}])

    async def no_delay(_):
        return None

    monkeypatch.setattr(live_api.asyncio, "sleep", no_delay)

    class Request:
        remaining = 3

        async def is_disconnected(self):
            self.remaining -= 1
            return self.remaining < 0

    route = next(route for route in live_api.router(lambda: "test").routes
                 if route.path.endswith("/events"))
    response = await route.endpoint(Request())
    snapshots = []
    async for event in response.body_iterator:
        if event.startswith("event: snapshot"):
            snapshots.append(json.loads(event.split("data: ")[1])[0])
    assert [row["cooldown_until"] for row in snapshots] == [None, 200000, None]


def test_source_watch_uses_shared_browser_business_schema(running):
    factory, _, _, _ = running
    from alerts import business
    from alerts.storage import Watch

    with factory.begin() as db:
        dataset = db.scalar(select(MarketDataset).where(MarketDataset.logical_symbol == "EURUSD"))
        instrument = dataset.instrument_id
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            response = client.post("/api/watches", json={"instrument_id": instrument,
                "name": "source integration", "kind": "price", "timeframe": "M1", "level": "1.25",
                "use_history": False})
            assert response.status_code == 201
            assert response.json()["instrument_id"] == instrument
        with factory.begin() as db:
            assert db.get(Watch, response.json()["id"]).instrument_id == instrument
        assert instrument in {row["id"] for row in business.instruments()}
    finally:
        api_module.app.dependency_overrides.clear()


def test_shared_chart_query_renews_source_demand(running):
    factory, _, _, _ = running
    with factory.begin() as db:
        dataset = db.scalar(select(MarketDataset).where(MarketDataset.logical_symbol == "GBPUSD"))
        instrument = dataset.instrument_id
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            response = client.post("/api/charts/data", json={"instrument": instrument,
                "series_kind": "managed", "timeframe": "M1", "client": "merged-source-chart"})
            assert response.status_code == 200
        with factory.begin() as db:
            assert db.scalar(select(MarketDemand).where(
                MarketDemand.instrument_id == instrument)) is not None
    finally:
        api_module.app.dependency_overrides.clear()
