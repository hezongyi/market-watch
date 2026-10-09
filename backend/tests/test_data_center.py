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
            configure(db, identity(provider_symbol=code).key, target_start=0, timeframes=["M1"])
        first = dataset_list(db, page_size=1)
        assert first["total"] == 3 and first["items"][0]["logical_symbol"] == "BTCUSD"
        assert dataset_list(db, page=2, page_size=1)["items"][0]["logical_symbol"] == "EURUSD"
        assert dataset_list(db, query="EUR")["total"] == 1
        assert dataset_list(db, query="%")["total"] == 0
        with pytest.raises(ValueError):
            dataset_list(db, page_size=1000)


def test_managed_list_excludes_registered_only_before_filters_and_paging(database):
    with database.begin() as db:
        for code in ("AAA", "BBB", "CCC", "DDD"):
            register(db, identity(provider_symbol=code), logical_symbol=code)
        for code in ("BBB", "DDD"):
            configure(db, identity(provider_symbol=code).key, target_start=0, timeframes=["M1"])
        db.get(DatasetMaintenance, identity(provider_symbol="DDD").key).paused = True
        db.flush()
        first = dataset_list(db, page_size=1)
        assert first["total"] == 2 and first["items"][0]["logical_symbol"] == "BBB"
        assert dataset_list(db, page=2, page_size=1)["items"][0]["logical_symbol"] == "DDD"
        assert dataset_list(db, query="AAA")["total"] == 0
        assert dataset_list(db, status="attention")["total"] == 2
        assert dataset_list(db, status="paused")["total"] == 1
        assert all(row["maintenance"]["configured"] for row in dataset_list(db)["items"])
        db.get(DatasetMaintenance, identity(provider_symbol="BBB").key).archived = True
        db.flush()
        assert dataset_list(db)["total"] == 1
        archived = dataset_list(db, status="archived")
        assert archived["total"] == 1 and archived["items"][0]["logical_symbol"] == "BBB"
        # A provider-only identity still has a detail endpoint for configuration.
        assert not dataset_detail(db, identity(provider_symbol="AAA").key)["maintenance"]["configured"]


def test_managed_api_and_candidates_share_configured_scope(database):
    with database.begin() as db:
        for code in ("AAA", "BBB"):
            register(db, identity(provider_symbol=code), logical_symbol=code)
        configure(db, identity(provider_symbol="BBB").key, target_start=0, timeframes=["M1"])
    api.app.dependency_overrides[api.authenticated] = lambda: "test"
    try:
        with TestClient(api.app) as client:
            managed = client.get("/api/market-data/center/datasets?page_size=1").json()
            candidates = client.get("/api/market-data/center/composite-candidates?page_size=1").json()
            assert managed["total"] == candidates["total"] == 1
            assert managed["items"][0]["id"] == candidates["items"][0]["dataset"]["id"] == identity(provider_symbol="BBB").key
            assert candidates["items"][0]["status"] == "needs_maintenance"
            assert client.get("/api/market-data/center/datasets?query=AAA").json()["total"] == 0
            assert client.get("/api/market-data/center/composite-candidates?query=AAA").json()["total"] == 0
            # Browsing either list must not create realtime collection demand.
            with database.begin() as db:
                assert db.scalar(select(MarketDemand)) is None
    finally:
        api.app.dependency_overrides.clear()


def test_atomic_create_rolls_back_invalid_maintenance_and_retry_returns_fixed_task(database):
    api.app.dependency_overrides[api.authenticated] = lambda: "test"
    body = {"request_id": "initial", "dataset": {"logical_symbol": "EURUSD", "provider_symbol": "EUR/USD",
        "asset_class": "forex", "precision": 5}, "maintenance": {"target_start": 0, "timeframes": ["M1"]}}
    try:
        with TestClient(api.app) as client:
            lookup = "/api/market-data/center/creations/initial?source=dukascopy&provider_symbol=EUR/USD&asset_class=forex&aggregation_calendar=ny17"
            assert client.get(lookup).json() == {"found": False}
            rejected = client.post("/api/market-data/center/datasets", json={**body,
                "maintenance": {"target_start": 0, "timeframes": ["invalid"]}})
            assert rejected.status_code == 422
            with database.begin() as db:
                assert db.scalar(select(func.count()).select_from(MarketDataset)) == 0
            created = client.post("/api/market-data/center/datasets", json=body)
            assert created.status_code == 201
            known = client.get(lookup).json()
            assert known["found"] and known["task"]["id"] == created.json()["task"]["id"]
            assert client.get(lookup.replace("EUR/USD", "XAU/USD")).json() == {"found": False}
            repeated = client.post("/api/market-data/center/datasets", json=body)
            assert repeated.status_code == 201 and repeated.json()["task"]["id"] == created.json()["task"]["id"]
            for path in ("center/datasets", "center/tasks", "center/platform"):
                assert client.get("/api/market-data/" + path).status_code == 200
            dataset = created.json()["dataset"]["id"]
            assert client.get(f"/api/market-data/center/datasets/{dataset}").status_code == 200
            assert client.get("/api/market-data/center/datasets/missing").status_code == 404
            assert client.get("/api/market-data/center/datasets?page_size=1000").status_code == 422
            assert client.get("/api/market-data/center/tasks?status=invalid").status_code == 422
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
            result = client.get("/api/market-data/center/creations/catalogue-retry", params={
                "source": "dukascopy", "provider_symbol": "EUR/USD", "asset_class": "forex",
                "aggregation_calendar": "ny17"}).json()
            assert result["found"] and result["task"]["id"] == ident
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


def test_task_filters_before_pagination_include_period_derivation(database):
    from alerts.storage import HistoryRun

    with database.begin() as db:
        ids = []
        for i, code in enumerate(("EURUSD", "XAUUSD", "BTCUSD", "OTHER")):
            register(db, identity(provider_symbol=code), logical_symbol=code)
            key = identity(provider_symbol=code).key
            configure(db, key, target_start=0, timeframes=["M1"])
            row = create_run(db, key, end=60000, request_id="filters")
            row.created_at = 100 + i
            row.status = ("pending", "retrying", "published", "published")[i]
            if i == 1:
                row.error, row.next_at = "unauthorized", 987654
            if i == 3:
                db.get(HistoryRun, row.id).completed_at = 500
            ids.append(row.id)
        db.flush()
        assert task_list(db)["total"] == 4  # Legacy API default unchanged.
        first = task_list(db, status="active", page_size=1)
        assert first["total"] == 3 and first["items"][0]["id"] == ids[2]
        assert first["items"][0]["status"] == "deriving"
        assert task_list(db, status="active", page=2, page_size=1)["items"][0]["id"] == ids[1]
        attention = task_list(db, status="attention")["items"]
        assert [x["id"] for x in attention] == [ids[1]]
        assert attention[0]["created_at"] == 101 and attention[0]["next_at"] == 987654
        assert task_list(db, status="history")["items"][0]["id"] == ids[3]
        assert task_list(db, query="XAU", status="active")["total"] == 1
        assert task_list(db, query="%", status="active")["total"] == 0
        assert task_list(db, source="oanda")["total"] == 0
        run = db.get(HistoryRun, ids[2])
        run.desired_state = "paused"
        db.flush()
        assert task_list(db, status="active")["total"] == 2
        paused = task_list(db, status="paused")["items"][0]
        assert paused["id"] == ids[2] and paused["updated_at"] == run.updated_at
        run.desired_state = "cancelled"
        db.flush()
        assert task_list(db, status="history")["total"] == 2
        assert db.scalar(select(MarketDemand)) is None
        with pytest.raises(ValueError):
            task_list(db, status="invalid")


def test_task_times_record_real_processing_and_not_poll_time(database):
    from alerts.history_maintenance import task_control
    from alerts.history_versions import version_report

    with database.begin() as db:
        register(db)
        configure(db, identity().key, target_start=0, timeframes=["M1", "H4"])
        ident = create_run(db, identity().key, end=120000, request_id="timestamps").id
        first = version_report(db, ident)
        assert first["started_at"] is None
    import_page(Adapter(), version_id=ident)
    with database.begin() as db:
        processing = version_report(db, ident)
        assert processing["started_at"] >= first["created_at"]
        assert processing["updated_at"] >= processing["started_at"]
        assert version_report(db, ident)["updated_at"] == processing["updated_at"]
        task_control(db, ident, "pause")
        paused = version_report(db, ident)
        assert paused["task_status"] == "paused" and paused["updated_at"] >= processing["updated_at"]


def test_derived_task_kind_is_not_a_supplier_import(database):
    from alerts.aggregation_policy import change_aggregation
    from alerts.history_versions import version_report

    with database.begin() as db:
        register(db)
        configure(db, identity().key, target_start=0, timeframes=["M1"])
        ident = create_run(db, identity().key, end=120000, request_id="task-kind").id
    import_page(Adapter(), version_id=ident)
    with database.begin() as db:
        _, _, derived = change_aggregation(db, identity().key, "utc0", version_id=ident)
        assert version_report(db, derived.id)["task_kind"] == "derive"
