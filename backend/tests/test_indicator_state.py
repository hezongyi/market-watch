"""Numerical contract against whole-span TA-Lib, never a moving page prefix."""

import json
import math
import random

import pytest
from alerts.chart_indicators import calculate
from alerts.indicator_state import IndicatorState


def prices(count=2400):
    rng = random.Random(117)
    rows, close = [], 120.0
    for at in range(count):
        close += rng.uniform(-0.3, 0.3)
        rows.append({"start": at * 60000, "end": (at + 1) * 60000, "high": close + rng.random(),
                     "low": close - rng.random(), "close": close, "complete": True})
    return rows


SPECS = [{"name": name, "params": params} for name, params in [
    ("SMA", {"period": 73}), ("EMA", {"period": 73}), ("LWMA", {"period": 73}),
    ("BBANDS", {"period": 73, "deviation": 2.4}), ("RSI", {"period": 73}),
    ("ATR", {"period": 73}), ("MACD", {"fast": 17, "slow": 71, "signal": 23}),
    ("STOCH", {"k": 71, "smooth": 17, "d": 23}),
]]


@pytest.mark.parametrize("spec", SPECS)
@pytest.mark.parametrize("shape", ["trend", "constant", "gaps"])
def test_full_initialization_and_json_checkpoint_match_talib(spec, shape):
    rows = prices()
    if shape == "constant":
        for row in rows:
            row.update(high=120.0, low=120.0, close=120.0)
    if shape == "gaps":
        rows[830]["gap_before"] = True
        rows[1300]["complete"] = False
    expected = calculate(rows, spec)
    engine = IndicatorState(spec)
    outputs = []
    for index, row in enumerate(rows):
        if index and index % 137 == 0:
            engine = IndicatorState(spec, json.loads(json.dumps(engine.checkpoint(), allow_nan=False)))
        outputs.append(engine.step(row))
    for series in expected["series"]:
        key = series["key"]
        for index, item in enumerate(series["values"]):
            actual = outputs[index][key]
            if item["value"] is None:
                assert actual is None, (key, index, actual)
            else:
                assert math.isclose(actual, item["value"], abs_tol=1e-8, rel_tol=1e-10), (key, index, actual, item)
    assert len(json.dumps(engine.checkpoint())) < 15000


@pytest.mark.parametrize("spec", SPECS)
def test_ticks_use_cloned_confirmed_state_and_correction_restarts_before_dependency(spec):
    rows = prices(1100)
    engine = IndicatorState(spec)
    for row in rows[:700]:
        engine.step(row)
    original = engine.checkpoint()
    corrected = {**rows[700], "close": rows[700]["close"] + 2}
    for row in [rows[700], corrected, rows[700]]:
        actual = engine.step(row, provisional=True)
        whole = calculate([*rows[:700], row], spec)
        assert actual == pytest.approx({item["key"]: item["values"][-1]["value"] for item in whole["series"]},
                                       abs=1e-8)
        assert engine.checkpoint() == original
    restored = IndicatorState(spec, original)
    tail = [corrected, *rows[701:]]
    actual = [restored.step(row) for row in tail]
    whole = calculate([*rows[:700], *tail], spec)
    assert actual[-1] == pytest.approx({item["key"]: item["values"][-1]["value"] for item in whole["series"]}, abs=1e-8)


def test_checkpoint_version_and_parameters_cannot_be_reinterpreted():
    state = IndicatorState({"name": "EMA", "params": {"period": 20}}).checkpoint()
    with pytest.raises(ValueError, match="不匹配"):
        IndicatorState({"name": "EMA", "params": {"period": 21}}, state)
    state["algorithm"] = "old"
    with pytest.raises(ValueError, match="不匹配"):
        IndicatorState({"name": "EMA", "params": {"period": 20}}, state)


def test_finite_dependencies_roll_out_seam_while_recursive_dependencies_keep_it():
    rows = prices(70)
    rows[20]["seam_at_start"] = True
    for name in ("SMA", "EMA", "RSI", "ATR", "LWMA", "BBANDS"):
        state = IndicatorState({"name": name, "params": {"period": 7}})
        for row in rows:
            state.step(row)
        recursive = name in ("EMA", "RSI", "ATR")
        assert state.state["seam"] is recursive
        assert state.state["origin"] == (0 if recursive else rows[-7]["start"])


@pytest.mark.parametrize("spec", [
    {"name": "MACD", "params": {"fast": 2, "slow": 3, "signal": 2}},
    {"name": "MACD", "params": {"fast": 499, "slow": 500, "signal": 500}},
    {"name": "EMA", "params": {"period": 500}},
    {"name": "RSI", "params": {"period": 2}},
    {"name": "STOCH", "params": {"k": 2, "smooth": 2, "d": 2}},
])
def test_boundary_parameters_still_follow_whole_origin_talib(spec):
    rows = prices(1300)
    state = IndicatorState(spec)
    actual = [state.step(row) for row in rows]
    for output in calculate(rows, spec)["series"]:
        assert [row[output["key"]] for row in actual] == pytest.approx(
            [row["value"] for row in output["values"]], abs=1e-8)
