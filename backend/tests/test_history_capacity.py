import pytest
from fastapi.testclient import TestClient
from alerts import api as api_module
from alerts.config import settings
from alerts.provider_history_policy import capacity, capabilities, save_capacity
from alerts import native_history_loads as loads
from alerts.chart_api import DataQuery


@pytest.fixture
def policy(database, monkeypatch):
    monkeypatch.setattr(settings, "native_history_default_bars", 200000)
    monkeypatch.setattr(settings, "native_history_max_bars", 1000000)
    monkeypatch.setattr(settings, "native_history_workspace_bars", 4000000)
    return database


def test_default_persistence_and_coupled_workspace(policy):
    assert capacity() == 200000
    assert capabilities()["workspace_bars"] == 800000
    version = capabilities()["version"]
    assert save_capacity(350000)["max_bars"] == 350000
    assert capacity() == 350000
    assert capabilities()["workspace_bars"] == 1400000
    assert capabilities()["version"] != version


def test_validation_and_lowering_apply_to_native_task(policy, monkeypatch):
    for value in [True, "200000", 200000.0, 19999, 1000001]:
        with pytest.raises(ValueError):
            save_capacity(value)
    query = DataQuery(instrument="EURUSD", series_kind="provider", timeframe="M5",
        limit=90000, countBack=90000, native_history={"chart_count": 4})
    loads.admit(query)
    save_capacity(80000)
    with pytest.raises(loads.CapacityExceeded, match="90,000.*80,000.*历史数据容量"):
        loads.admit(query)
    save_capacity(200000)
    loads.admit(query)
    monkeypatch.setattr(settings, "native_history_max_bars", 100000)
    assert capacity() == 100000
    with pytest.raises(ValueError):
        save_capacity(200000)


def test_authenticated_route_strict_input_and_authoritative_result(policy):
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            for value in [True, "200000", 200000.0, 19999, 1000001]:
                assert client.post("/api/charts/history-capacity", json={"max_bars": value}).status_code == 422
            result = client.post("/api/charts/history-capacity", json={"max_bars": 240000})
            assert result.status_code == 200
            assert result.json()["max_bars"] == 240000
            assert client.get("/api/charts/history-capabilities").json() == result.json()
    finally:
        api_module.app.dependency_overrides.clear()


def test_capacity_obeys_cancel_and_expired_provider_context(policy):
    import threading
    import time
    from alerts import provider_cache as cache
    token = cache.DEADLINE.set(time.monotonic() - 1)
    try:
        with pytest.raises(TimeoutError):
            capacity()
    finally:
        cache.DEADLINE.reset(token)
    cancel = threading.Event()
    cancel.set()
    token = cache.CANCELLED.set(cancel)
    try:
        with pytest.raises(TimeoutError):
            capacity()
    finally:
        cache.CANCELLED.reset(token)
