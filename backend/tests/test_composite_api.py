"""Authenticated management is pure; only explicit first-use commands demand live."""

from alerts import api
from alerts.history_maintenance import configure
from alerts.storage import MarketComposite, MarketDemand
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from test_composite_definitions import PROOF, prepare, publish
from test_market_contracts import identity


def test_mapping_candidate_first_use_and_chart_api(database, monkeypatch):
    catalog = prepare(database, monkeypatch)
    publish(database)
    with database.begin() as db:
        configure(db, identity().key, target_start=0, timeframes=["M1"])
    monkeypatch.setattr("alerts.composite_definitions.now_ms", lambda: 165725000)
    api.app.dependency_overrides[api.authenticated] = lambda: "test"
    try:
        with TestClient(api.app) as client:
            base = "/api/market-data"
            candidates = client.get(base + "/center/composite-candidates").json()
            assert candidates["items"][0]["status"] == "needs_mapping"
            saved = client.post(base + f"/datasets/{identity().key}/mappings",
                json={"catalog_id": catalog, "match": PROOF})
            assert saved.status_code == 201
            mapping = saved.json()["id"]
            assert client.get(base + f"/datasets/{identity().key}/mappings").json()["items"][0]["id"] == mapping
            assert client.get(base + "/center/composite-candidates").json()["items"][0]["status"] == "ready_to_open"
            assert client.get(base + "/center/composites").json()["total"] == 0
            with database.begin() as db:
                assert db.scalar(select(MarketComposite)) is None and db.scalar(select(MarketDemand)) is None
            body = {"dataset_id": identity().key, "mapping_id": mapping, "client": "first-chart"}
            opened = client.post(base + "/composites/use", json=body)
            assert opened.status_code == 201, opened.text
            result = opened.json()
            repeated = client.post(base + "/composites/use", json=body)
            assert repeated.json()["id"] == result["id"]
            assert result["usage"]["charts"] == 1 and result["health"]["strategy_readiness"] == "no_strategies"
            assert result["status"] == "preparing"
            assert client.get(base + "/center/composites").json()["total"] == 1
            assert client.get(base + f"/composites/{result['id']}").status_code == 200
            assert client.get(base + f"/composites/{result['id']}/requests").json()["items"] == []
            page = client.get(base + f"/composites/{result['id']}/chart?before=165600000&count=2")
            assert page.status_code == 200 and len(page.json()["bars"]) == 2
            assert client.get(base + "/center/composites?query=%25").json()["total"] == 0
            assert client.get(base + "/center/composites?page_size=101").status_code == 422
            with database.begin() as db:
                assert db.scalar(select(func.count()).select_from(MarketDemand)) == 1
    finally:
        api.app.dependency_overrides.clear()


def test_candidate_requires_history_before_day_seam_without_creating_demand(database, monkeypatch):
    from alerts.composite_center import candidates
    from alerts.composite_definitions import save_mapping

    catalog = prepare(database, monkeypatch)
    publish(database, end=7200000)
    with database.begin() as db:
        configure(db, identity().key, target_start=0, timeframes=["M1"])
        save_mapping(db, identity().key, catalog, PROOF)
        item = next(row for row in candidates(db)["items"] if row["dataset"]["id"] == identity().key)
        assert item["status"] == "needs_maintenance" and "日界拼接点" in item["reason"]
        assert item["recommended_mapping_id"]
        assert db.scalar(select(MarketComposite)) is None and db.scalar(select(MarketDemand)) is None


def test_legacy_request_cannot_bypass_verified_source_rules(database, monkeypatch):
    from alerts.storage import RealtimeMapping

    catalog = prepare(database, monkeypatch)
    api.app.dependency_overrides[api.authenticated] = lambda: "test"
    try:
        with TestClient(api.app) as client:
            forged = {**PROOF, "underlying": "GBP", "historical_product": "cfd", "live_product": "cfd"}
            saved = client.post(f"/api/market-data/datasets/{identity().key}/mappings",
                json={"catalog_id": catalog, "match": forged})
            assert saved.status_code == 422, saved.text
            with database.begin() as db:
                assert db.scalar(select(RealtimeMapping)) is None
                assert db.scalar(select(MarketDemand)) is None
    finally:
        api.app.dependency_overrides.clear()
