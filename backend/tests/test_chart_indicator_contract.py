"""Exercise public registration, catalog and numerical contracts."""

import json

import numpy as np
import pytest
from alerts import chart_indicators as indicators


@pytest.fixture
def plugin():
    name = "CONTRACT_TEST_V1"
    meta = {
        "label": "测试",
        "pane": "sub",
        "params": {"period": 3},
        "parameter_schema": {"period": {"type": "integer", "min": 2, "max": 500, "default": 3}},
        "series": [{"key": "value", "type": "line"}],
        "history_requirement": lambda p: p["period"] + 7,
    }
    yield name, meta
    indicators.CATALOG.pop(name, None)
    indicators.CALCULATORS.pop(name, None)


def rows(count=6):
    return [
        {"start": i, "high": i + 2, "low": i, "close": i + 1, "complete": True}
        for i in range(count)
    ]


def test_catalog_and_empty_calculation_never_execute_algorithm(plugin, monkeypatch):
    name, meta = plugin
    calls = []

    def calculator(*args):
        calls.append(args)
        raise AssertionError("must not execute")

    indicators.register(name, meta, calculator)
    monkeypatch.setitem(indicators.CALCULATORS, "SMA", calculator)
    catalog = indicators.public_catalog()
    assert catalog[name]["series"] == [{"key": "value", "type": "line"}]
    assert "history_requirement" not in catalog[name]
    json.dumps(catalog, allow_nan=False)
    assert indicators.calculate([], {"name": name})["series"][0]["values"] == []
    assert not calls


def test_custom_history_takes_precedence_over_period(plugin):
    name, meta = plugin
    indicators.register(name, meta, lambda h, low, c, p: {"value": c})
    assert indicators.history_requirement({"name": name}) == 10
    assert indicators.history_requirement({"name": name, "params": {"period": 20}}) == 27


def test_catalog_filters_nested_plugin_details_and_preserves_metadata(plugin):
    name, meta = plugin
    meta["series"][0]["formatter"] = lambda value: str(value)
    meta["parameter_schema"]["period"]["validator"] = lambda value: value > 0
    indicators.register(name, meta, lambda h, low, c, p: {"value": c})
    catalog = indicators.public_catalog()
    json.dumps(catalog, allow_nan=False)
    assert catalog[name]["series"] == [{"key": "value", "type": "line"}]
    assert catalog[name]["parameter_schema"] == {
        "period": {"type": "integer", "min": 2, "max": 500, "default": 3}
    }
    catalog[name]["series"][0]["key"] = "changed"
    catalog[name]["parameter_schema"]["period"]["default"] = 99
    assert indicators.CATALOG[name]["series"][0]["key"] == "value"
    assert indicators.validate({"name": name})[1] == {"period": 3}


def test_builtin_display_metadata_preserves_parameter_and_output_contracts():
    meta = indicators.public_catalog()["MACD"]
    assert meta["params"] == {"fast": 12, "slow": 26, "signal": 9}
    assert {key: value["label"] for key, value in meta["parameter_schema"].items()} == {
        "fast": "快线周期", "slow": "慢线周期", "signal": "信号周期",
    }
    assert [(output["key"], output["label"]) for output in meta["series"]] == [
        ("macd", "MACD 线"), ("signal", "信号线"), ("histogram", "柱状差值"),
    ]


@pytest.mark.parametrize(
    "change",
    [
        {"pane": "other"},
        {"series": []},
        {"series": [{"key": "x", "type": "line"}, {"key": "x", "type": "line"}]},
        {"series": [{"key": "value", "type": "unknown"}]},
        {"parameter_schema": {}},
        {"history_requirement": 5},
        {"description": lambda: "private"},
        {"calculation": {}},
    ],
)
def test_bad_declarations_fail_at_registration(plugin, change):
    name, meta = plugin
    with pytest.raises(ValueError, match=name):
        indicators.register(name, meta | change, lambda *args: {})
    assert name not in indicators.CATALOG


def test_duplicate_registration_and_metadata_isolation(plugin):
    name, meta = plugin
    indicators.register(name, meta, lambda h, low, c, p: {"value": c})
    meta["series"][0]["key"] = "changed"
    assert indicators.public_catalog()[name]["series"][0]["key"] == "value"
    with pytest.raises(ValueError, match=name):
        indicators.register(name, meta, lambda *args: {})


@pytest.mark.parametrize(
    "calculator",
    [
        lambda h, low, c, p: {},
        lambda h, low, c, p: {"wrong": c},
        lambda h, low, c, p: {"value": c, "extra": c},
        lambda h, low, c, p: {"value": c[:-1]},
        lambda h, low, c, p: {"value": c.reshape(-1, 1)},
        lambda h, low, c, p: {"value": ["1"] * len(c)},
        lambda h, low, c, p: {"value": [True] * len(c)},
    ],
)
def test_invalid_outputs_are_errors_with_indicator_identity(plugin, calculator):
    name, meta = plugin
    indicators.register(name, meta, calculator)
    with pytest.raises(ValueError, match=name):
        indicators.calculate(rows(), {"name": name})


def test_output_order_is_a_contract(plugin):
    name, meta = plugin
    meta["series"] = [{"key": "a", "type": "line"}, {"key": "b", "type": "line"}]
    indicators.register(name, meta, lambda h, low, c, p: {"b": c, "a": c})
    with pytest.raises(ValueError, match="output keys/order"):
        indicators.calculate(rows(), {"name": name})


def test_calculator_cannot_modify_inputs(plugin):
    name, meta = plugin

    def calculator(h, low, c, p):
        c[0] = 99
        return {"value": c}

    indicators.register(name, meta, calculator)
    source = rows()
    with pytest.raises(ValueError, match=name + ": calculator failed"):
        indicators.calculate(source, {"name": name})
    assert source[0]["close"] == 1


def test_zero_nan_and_incomplete_values(plugin):
    name, meta = plugin

    def calculator(h, low, c, p):
        value = np.zeros(len(c))
        value[0] = np.nan
        return {"value": value}

    indicators.register(name, meta, calculator)
    source = rows()
    source[3]["complete"] = False
    values = indicators.calculate(source, {"name": name})["series"][0]["values"]
    assert [row["value"] for row in values] == [None, 0, 0, None, None, 0]


def test_builtin_order_parameters_and_warmup_remain_stable():
    expected = {
        "BBANDS": ["upper", "middle", "lower"],
        "MACD": ["macd", "signal", "histogram"],
        "STOCH": ["k", "d"],
    }
    for name, meta in indicators.public_catalog().items():
        assert [s["key"] for s in meta["series"]] == expected.get(name, ["value"])
        assert indicators.validate({"name": name})[1] == meta["params"]
    assert [
        indicators.history_requirement({"name": name})
        for name in ("SMA", "EMA", "LWMA", "BBANDS", "RSI", "MACD", "ATR", "STOCH")
    ] == [19, 200, 19, 19, 140, 350, 140, 17]
    with pytest.raises(ValueError, match="MACD"):
        indicators.validate({"name": "MACD", "params": {"fast": 26}})
    assert (
        indicators.validate({"name": "BBANDS", "params": {"deviation": 0.1}})[1]["deviation"] == 0.1
    )
    for value in (True, 1, 501, 2.5):
        with pytest.raises(ValueError):
            indicators.validate({"name": "SMA", "params": {"period": value}})


def test_authenticated_catalog_serializes_declarations_without_calculation(
    database, monkeypatch, plugin
):
    from alerts import api as api_module
    from fastapi.testclient import TestClient

    calls = []

    def forbidden(*args):
        calls.append(args)
        raise AssertionError("catalog executed an algorithm")

    name, meta = plugin
    meta["series"][0]["formatter"] = forbidden
    meta["parameter_schema"]["period"]["validator"] = forbidden
    indicators.register(name, meta, forbidden)
    for name in indicators.CALCULATORS:
        monkeypatch.setitem(indicators.CALCULATORS, name, forbidden)
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            response = client.get("/api/advanced-charts/catalog")
            assert response.status_code == 200
            assert list(response.json()["MACD"]["params"]) == ["fast", "slow", "signal"]
            assert len(response.json()) == 9
            assert response.json()[plugin[0]]["series"] == [{"key": "value", "type": "line"}]
            assert not calls
    finally:
        api_module.app.dependency_overrides.clear()
