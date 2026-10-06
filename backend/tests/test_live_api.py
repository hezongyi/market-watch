from alerts import api as api_module
from alerts import live_pricing as live
from alerts.storage import MarketDataset, MarketDemand
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
