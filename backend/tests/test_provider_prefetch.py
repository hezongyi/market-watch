"""Provider budgets are acquisition totals, independent of viewport geometry."""

import pytest
from alerts import api as api_module
from alerts import provider_history_policy as policy
from alerts.chart_query import NativeHistory
from fastapi.testclient import TestClient


def test_defaults_and_independent_durable_settings(database):
    config = policy.prefetch_capabilities()
    assert config["sources"]["oanda"] == {"initial_bars": 2000, "reserve_bars": 4000}
    values = config["sources"]
    values["oanda"] = {"initial_bars": 1800, "reserve_bars": 0}
    policy.save_prefetch(values)
    assert policy.prefetch_capabilities()["sources"] == values
    assert policy.source_prefetch("oanda")["initial_bars"] == 1800
    assert policy.source_prefetch("binance")["initial_bars"] == 1000


def test_prefetch_strict_validation_and_capacity(database):
    for value in [True, "2000", 2.5, -1, 20001]:
        values = policy.prefetch_capabilities()["sources"]
        values["oanda"]["initial_bars"] = value
        with pytest.raises(ValueError):
            policy.save_prefetch(values)
    values = policy.prefetch_capabilities()["sources"]
    values["oanda"]["reserve_bars"] = 100
    with pytest.raises(ValueError):
        policy.save_prefetch(values)
    values["oanda"] = {"initial_bars": 0, "reserve_bars": 0}
    policy.save_prefetch(values)
    assert policy.source_prefetch("oanda") == values["oanda"]


def test_opportunistic_total_ignores_screen_but_never_reduces_demand(database):
    context = NativeHistory(chart_count=1, screen_bars=187)
    kwargs = dict(source="oanda", hot=False, first=True, enabled=True)
    assert policy.optional_bars(context, 200, 0, **kwargs) == 1800
    assert policy.optional_bars(context, 200, 100, **kwargs) == 1700
    assert policy.optional_bars(context, 3000, 0, **kwargs) == 0
    assert policy.optional_bars(context, 200, 0, python=True, **kwargs) == 0
    assert policy.optional_bars(context, 200, 0, **(kwargs | {"enabled": False})) == 0


def test_prefetch_authenticated_strict_http(database):
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            response = client.get("/api/charts/provider-prefetch")
            assert response.status_code == 200
            config = response.json()
            config["sources"]["fxcm"] = {"initial_bars": 300, "reserve_bars": 0}
            assert client.post("/api/charts/provider-prefetch", json={
                "version": 1, "sources": config["sources"],
            }).status_code == 200
            config["sources"]["fxcm"]["initial_bars"] = True
            assert client.post("/api/charts/provider-prefetch", json={
                "version": 1, "sources": config["sources"],
            }).status_code == 422
    finally:
        api_module.app.dependency_overrides.clear()
