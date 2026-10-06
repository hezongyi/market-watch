"""Management reads, atomic dataset/task creation and per-period usability."""

import pytest
from alerts import api
from alerts.data_center import dataset_detail, dataset_list, task_list
from alerts.history_artifacts import artifact_tick
from alerts.history_maintenance import configure, create_run
from alerts.history_versions import import_page
from alerts.storage import DatasetMaintenance, HistoryVersion, MarketDataset, MarketDemand
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from test_history_maintenance import Adapter
from test_market_contracts import identity
from test_market_datasets import register


def test_dataset_available_only_after_period_publication_and_pause_keeps_it(database):
    with database.begin() as db:
        register(db)
        configure(db, identity().key, target_start=0, timeframes=["M1", "H4"])
        ident = create_run(db, identity().key, end=120000, request_id="initial").id
    import_page(Adapter(), version_id=ident)
    with database.begin() as db:
        detail = dataset_detail(db, identity().key)
        assert detail["usable_timeframes"] == []
        assert dataset_list(db, status="available")["total"] == 0
    while artifact_tick(ident):
        pass
    with database.begin() as db:
        assert dataset_detail(db, identity().key)["usable_timeframes"] == ["H4", "M1"]
        assert dataset_list(db, status="available")["total"] == 1
        db.get(DatasetMaintenance, identity().key).paused = True
        db.flush()
        assert dataset_list(db, status="paused")["total"] == 1
        assert dataset_list(db, status="available")["total"] == 1
        assert task_list(db)["items"][0]["controllable"] is False
        assert db.scalar(select(MarketDemand)) is None


def test_server_pagination_and_literal_filters(database):
    with database.begin() as db:
        for code in ("EURUSD", "XAUUSD", "BTCUSD"):
            register(db, identity(provider_symbol=code), logical_symbol=code)
        first = dataset_list(db, page_size=1)
        assert first["total"] == 3 and first["items"][0]["logical_symbol"] == "BTCUSD"
        assert dataset_list(db, page=2, page_size=1)["items"][0]["logical_symbol"] == "EURUSD"
        assert dataset_list(db, query="EUR")["total"] == 1
        assert dataset_list(db, query="%")["total"] == 0
        with pytest.raises(ValueError):
            dataset_list(db, page_size=1000)


def test_atomic_create_rolls_back_invalid_maintenance_and_retry_returns_fixed_task(database):
    api.app.dependency_overrides[api.authenticated] = lambda: "test"
    body = {"request_id": "initial", "dataset": {"logical_symbol": "EURUSD", "provider_symbol": "EUR/USD",
        "asset_class": "forex", "precision": 5}, "maintenance": {"target_start": 0, "timeframes": ["M1"]}}
    try:
        with TestClient(api.app) as client:
            rejected = client.post("/api/market-data/center/datasets", json={**body,
                "maintenance": {"target_start": 0, "timeframes": ["invalid"]}})
            assert rejected.status_code == 422
            with database.begin() as db:
                assert db.scalar(select(func.count()).select_from(MarketDataset)) == 0
            created = client.post("/api/market-data/center/datasets", json=body)
            assert created.status_code == 201
            repeated = client.post("/api/market-data/center/datasets", json=body)
            assert repeated.status_code == 201 and repeated.json()["task"]["id"] == created.json()["task"]["id"]
            for path in ("center/datasets", "center/tasks", "center/platform"):
                assert client.get("/api/market-data/" + path).status_code == 200
            dataset = created.json()["dataset"]["id"]
            assert client.get(f"/api/market-data/center/datasets/{dataset}").status_code == 200
            assert client.get("/api/market-data/center/datasets/missing").status_code == 404
            assert client.get("/api/market-data/center/datasets?page_size=1000").status_code == 422
            boundary = client.get("/api/market-data/date-boundary?date=2026-07-06&calendar=ny17").json()
            from datetime import UTC, datetime
            assert boundary["start"] == int(datetime(2026, 7, 5, 21, tzinfo=UTC).timestamp() * 1000)
            assert client.get("/api/market-data/date-boundary?date=no&calendar=ny17").status_code == 422
        with database.begin() as db:
            assert db.scalar(select(MarketDemand)) is None
    finally:
        api.app.dependency_overrides.clear()


def test_new_m1_publication_preserves_previous_period_usability(database):
    with database.begin() as db:
        register(db)
        configure(db, identity().key, target_start=0, timeframes=["M1", "H4"])
        parent = create_run(db, identity().key, end=120000, request_id="initial").id
    import_page(Adapter(), version_id=parent)
    while artifact_tick(parent):
        pass
    with database.begin() as db:
        child = create_run(db, identity().key, end=180000, request_id="new").id
    while import_page(Adapter(), version_id=child):
        pass
    with database.begin() as db:
        detail = dataset_detail(db, identity().key)
        assert detail["latest_version_id"] == child
        assert detail["usable_timeframes"] == ["H4", "M1"]
        assert all(p["available_version_id"] == parent for p in detail["periods"])
        assert dataset_list(db, status="available")["total"] == 1


@pytest.mark.parametrize("use_catalog", [False, True])
def test_create_retry_uses_fixed_request_before_mutable_catalogue(database, monkeypatch, use_catalog):
    from alerts import history_catalog

    body = {"request_id": "catalogue-retry", "dataset": {"logical_symbol": "EURUSD",
        "provider_symbol": "EUR/USD", "asset_class": "forex", "precision": 5},
        "maintenance": {"target_start": 0, "timeframes": ["M1"]}}
    if use_catalog:
        with database.begin() as db:
            item = history_catalog.catalog(db, source="dukascopy", query="EURUSD")["items"][0]
        body["dataset"]["catalog_id"] = item["catalog_id"]
    api.app.dependency_overrides[api.authenticated] = lambda: "test"
    try:
        with TestClient(api.app) as client:
            created = client.post("/api/market-data/center/datasets", json=body)
            assert created.status_code == 201
            ident = created.json()["task"]["id"]
            with database.begin() as db:
                request = db.get(HistoryVersion, ident).manifest["maintenance"]["creation_request"]
                if not use_catalog:
                    # Shape of manifests published before catalogue selection existed.
                    assert "catalog_id" not in request["dataset"]
            def unavailable(*args, **kwargs):
                raise ValueError("来源目录已变化")
            monkeypatch.setattr(history_catalog, "validate_selection", unavailable)
            retry = client.post("/api/market-data/center/datasets", json=body)
            assert retry.status_code == 201 and retry.json()["task"]["id"] == ident
            changed = client.post("/api/market-data/center/datasets", json={**body,
                "dataset": {**body["dataset"], "precision": 3}})
            assert changed.status_code == 422 and "创建配置" in changed.text
            if use_catalog:
                new = client.post("/api/market-data/center/datasets", json={**body, "request_id": "new"})
                assert new.status_code == 422 and "来源目录" in new.text
    finally:
        api.app.dependency_overrides.clear()


def test_chart_api_pins_period_and_exclusive_cursor_to_selected_version(database):
    with database.begin() as db:
        register(db)
        configure(db, identity().key, target_start=0, timeframes=["M1", "H4"])
        parent = create_run(db, identity().key, end=180000, request_id="initial").id
    import_page(Adapter(), version_id=parent)
    while artifact_tick(parent):
        pass
    api.app.dependency_overrides[api.authenticated] = lambda: "test"
    try:
        with TestClient(api.app) as client:
            path = f"/api/market-data/versions/{parent}/chart"
            newest = client.get(path, params={"timeframe": "M1", "count": 2})
            assert newest.status_code == 200
            assert [r["start"] for r in newest.json()["bars"]] == [60000, 120000]
            before = newest.json()["next_before"]
            older = client.get(path, params={"before": before, "count": 2}).json()
            assert [r["start"] for r in older["bars"]] == [0]
            assert older["version_id"] == parent and older["next_before"] is None
            assert client.get(path, params={"count": 5001}).status_code == 422
            assert client.get(path, params={"timeframe": "D1"}).status_code == 422
        with database.begin() as db:
            assert db.scalar(select(MarketDemand)) is None
    finally:
        api.app.dependency_overrides.clear()
