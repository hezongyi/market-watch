from decimal import Decimal as D

import pytest
from alerts.chart_alert_domain import Operand
from alerts.chart_alert_values import operand_values


def rows(prices, incomplete=None, gap=None):
    return [{"start": i * 60_000, "end": (i + 1) * 60_000,
             "open": str(value), "high": str(value + 1), "low": str(value - 1),
             "close": str(value), "complete": i != incomplete, "gap_before": i == gap}
            for i, value in enumerate(prices)]


def indicator(name, **parameters):
    return Operand(kind="indicator", indicator={
        "name": name, "params": parameters,
        "output": "macd" if name == "MACD" else "value",
    })


@pytest.mark.parametrize("name,params,expected", [
    ("SMA", {"period": 3}, [None, None, D(12), D(14), D(16)]),
    ("EMA", {"period": 3}, [None, None, D(12), D(14), D(16)]),
    ("RSI", {"period": 3}, [None, None, None, D(100), D(100)]),
])
def test_known_small_vectors_preserve_warmup_and_output_values(name, params, expected):
    assert operand_values(rows([10, 12, 14, 16, 18]), indicator(name, **params)) == expected


def test_macd_zero_is_a_valid_output_not_missing_data():
    output = operand_values(rows([10] * 50), indicator("MACD", fast=3, slow=5, signal=2))
    assert output[:5] == [None] * 5
    assert output[5:] == [D(0)] * 45


@pytest.mark.parametrize("name,params", [
    ("SMA", {"period": 3}), ("EMA", {"period": 3}),
    ("RSI", {"period": 3}), ("MACD", {"fast": 3, "slow": 5, "signal": 2}),
])
def test_temporary_bar_recomputes_from_confirmed_history_without_advancing_it(name, params):
    spec = indicator(name, **params)
    prices = [10, 12, 11, 15, 14, 13, 12, 17, 13, 18]
    confirmed = rows(prices)
    before = operand_values(confirmed, spec)
    temporary = rows([*prices, 30], incomplete=10)
    assert operand_values(temporary, spec)[-1] is None
    provisional = operand_values(temporary, spec, provisional=True)
    assert provisional == operand_values(rows([*prices, 30]), spec)
    assert temporary[-1]["complete"] is False
    assert operand_values(confirmed, spec) == before
    temporary[-1]["close"] = "20"
    temporary[-1]["high"] = "31"
    assert operand_values(temporary, spec, provisional=True) == operand_values(rows([*prices, 20]), spec)


def test_incomplete_history_and_known_gap_restart_recursive_warmup():
    spec = indicator("EMA", period=3)
    assert operand_values(rows([10, 12, 14, 16, 18, 20, 22], incomplete=3), spec) == [
        None, None, D(12), None, None, None, D(20),
    ]
    assert operand_values(rows([10, 12, 14, 16, 18, 20], gap=3), spec) == [
        None, None, D(12), None, None, D(18),
    ]
