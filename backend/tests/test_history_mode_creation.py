"""Real API registration and capability intersection without supplier I/O."""

import pytest
from alerts import api
from alerts.akshare_catalog import SEEDS, seed, stable_id
from alerts.config import settings
from alerts.history_versions import import_page
from alerts.source_registry import capabilities
from alerts.storage import DatasetSource, HistoryVersion, MarketCatalog, MarketDataset
from fastapi.testclient import TestClient
from test_native_history_archive import Adapter as BaseAdapter
from test_native_history_archive import day, drain, stamp


class Adapter(BaseAdapter):
    def native_page(self, identity, start, end):
        return super().native_page(identity, start, end).model_copy(update={"volume_unit": "lots"})


@pytest.fixture
def client(database, monkeypatch):
    monkeypatch.setattr(settings, "akshare_enabled", True)
    seed()
    api.app.dependency_overrides[api.authenticated] = lambda: "test"
    try:
        with TestClient(api.app) as client:
            yield client
    finally:
        api.app.dependency_overrides.clear()


def body(**patch):
    dataset = {"source": "akshare", "provider_symbol": "SZSE:000001", "logical_symbol": "SZ000001",
        "catalog_id": stable_id("SZSE:000001"), "asset_class": "equity", "precision": 4,
        "mode": "base_d1", "adjustment": "none", "aggregation_calendar": "source_date"}
    dataset.update(patch)
    return {"dataset": dataset, "maintenance": {"target_start": stamp("2023-12-01"),
        "timeframes": ["D1", "W1", "MN"], "timezone": "Asia/Shanghai", "daily_minute": 1080},
        "request_id": "mode-create", "create_only": True}


def test_d1_creation_pure_preflight_idempotency_and_real_period_ranges(client, database):
    draft = body()
    result = client.get("/api/market-data/history-catalog/search?source=akshare").json()
    assert len(result["items"]) == len(SEEDS)
    with database.begin() as db:
        assert db.query(MarketDataset).count() == 0
    check = client.post("/api/market-data/center/datasets/check", json={**draft["dataset"],
        "timeframes": ["D1", "W1", "MN"], "start_date": "2023-12-01"})
    assert check.status_code == 200 and check.json()["status"] == "ready"
    created = client.post("/api/market-data/center/datasets", json=draft)
    assert created.status_code == 201, created.text
    ident, version = created.json()["dataset"]["id"], created.json()["task"]["id"]
    again = client.post("/api/market-data/center/datasets", json=draft)
    assert again.status_code == 201 and again.json()["task"]["id"] == version
    with database.begin() as db:
        assert db.get(DatasetSource, ident) is None
    drain(version, Adapter({"D1": [day("2024-01-02")]}))
    detail = client.get(f"/api/market-data/center/datasets/{ident}").json()
    assert detail["usable_timeframes"] == ["D1", "MN", "W1"]
    assert next(p for p in detail["periods"] if p["timeframe"] == "D1")["available_start"] == stamp("2024-01-02")
    coverage = client.get(f"/api/market-data/versions/{version}/coverage").json()
    assert coverage["items"][0]["timeframe"] == "D1" and coverage["items"][0]["observed_bars"] == 1
    lookup = client.get("/api/market-data/center/creations/mode-create?source=akshare&provider_symbol=SZSE:000001&asset_class=equity&mode=base_d1&adjustment=none&aggregation_calendar=source_date")
    assert lookup.status_code == 200 and lookup.json()["found"]


def test_native_whitelist_intersection_rejects_unverified_requests(client, database):
    with database.begin() as db:
        row = db.get(MarketCatalog, stable_id("SZSE:000001"))
        row.metadata_json = {**row.metadata_json, "verified_frames": {"none": ["M3", "M5", "M15"]}}
    data = body(mode="native_periods")
    data["maintenance"]["timeframes"] = ["M5", "M15"]
    response = client.post("/api/market-data/center/datasets", json=data)
    assert response.status_code == 201, response.text
    assert {frame["timeframe"] for frame in response.json()["task"]["frames"]} == {"M5", "M15"}
    data["maintenance"]["timeframes"] = ["M3"]
    data["request_id"] = "bad"
    assert client.post("/api/market-data/center/datasets", json=data).status_code == 422
    assert not capabilities("yahoo")["history_m1"]


def test_newly_verified_period_requires_explicit_saved_selection(client, database):
    from alerts.storage import DatasetFrameSource, DatasetMaintenance
    from sqlalchemy import select

    draft = body(mode="native_periods")
    draft["maintenance"]["timeframes"] = ["D1"]
    created = client.post("/api/market-data/center/datasets", json=draft)
    assert created.status_code == 201, created.text
    ident = created.json()["dataset"]["id"]
    with database.begin() as db:
        row = db.get(MarketCatalog, stable_id("SZSE:000001"))
        row.metadata_json = {**row.metadata_json, "verified_frames": {"none": ["D1", "M5", "M3"]}}
    detail = client.get(f"/api/market-data/center/datasets/{ident}")
    assert detail.status_code == 200
    assert set(detail.json()["selectable_timeframes"]) == {"D1", "M5"}
    assert detail.json()["input_timeframes"] == ["D1"]
    with database.begin() as db:
        assert db.get(DatasetMaintenance, ident).timeframes == ["D1"]
        assert set(db.scalars(select(DatasetFrameSource.timeframe).where(
            DatasetFrameSource.dataset_id == ident))) == {"D1"}
    saved = client.post(f"/api/market-data/datasets/{ident}/maintenance", json={
        **draft["maintenance"], "timeframes": ["D1", "M5"],
        "expected_configuration_revision": detail.json()["maintenance"]["configuration_revision"]})
    assert saved.status_code == 200, saved.text
    with database.begin() as db:
        assert set(db.get(DatasetMaintenance, ident).timeframes) == {"D1", "M5"}
        assert set(db.scalars(select(DatasetFrameSource.timeframe).where(
            DatasetFrameSource.dataset_id == ident))) == {"D1", "M5"}
        # An existing task keeps its frozen input set after the plan is edited.
        from alerts.storage import HistoryFrameRun

        assert set(db.scalars(select(HistoryFrameRun.timeframe).where(
            HistoryFrameRun.version_id == created.json()["task"]["id"]))) == {"D1"}


def test_hk_default_start_uses_successful_probe_not_unverified_year(client, database):
    route = "/api/market-data/history-catalog/search?source=akshare&query=HKEX:00700"
    entry = client.get(route).json()["items"][0]
    assert entry["availability"] == "probe_required" and entry["default_start_date"] is None
    with database.begin() as db:
        row = db.get(MarketCatalog, stable_id("HKEX:00700"))
        row.metadata_json = {**row.metadata_json, "verified_frames": {"none": ["D1"]},
            "probes": {"none": {"D1": {"status": "verified", "requested_start": stamp("2026-10-22")}}}}
    assert client.get(route).json()["items"][0]["default_start_date"] == "2026-10-22"


def test_published_frame_checkpoints_cannot_be_rewritten(client, database):
    from alerts.storage import HistoryFrameRun

    version = client.post("/api/market-data/center/datasets", json=body()).json()["task"]["id"]
    drain(version, Adapter({"D1": [day("2024-01-02")]}))
    with pytest.raises(ValueError, match="immutable"):
        with database.begin() as db:
            db.get(HistoryFrameRun, (version, "D1")).status = "pending"


def test_pause_resume_and_multiple_page_checkpoint(client, database):
    from alerts.history_maintenance import task_control
    from alerts.market_contracts import NativeCandleBatch
    from alerts.storage import HistoryFrameRun

    version = client.post("/api/market-data/center/datasets", json=body()).json()["task"]["id"]

    def first(identity, start, end):
        return NativeCandleBatch(identity=identity, timeframe="D1", window_start=start,
            window_end=end, observed_at=end, checkpoint=stamp("2024-01-03"), rows=[day("2024-01-02")],
            result={"status": "data"}, volume_kind="quantity", volume_unit="lots")

    assert import_page(Adapter({"D1": first}), version_id=version)
    with database.begin() as db:
        assert db.get(HistoryFrameRun, (version, "D1")).cursor == stamp("2024-01-03")
        task_control(db, version, "pause")
    adapter = Adapter({"D1": []})
    assert not import_page(adapter, version_id=version) and adapter.calls == []
    with database.begin() as db:
        task_control(db, version, "resume")
        assert db.get(HistoryVersion, version).status == "pending"
