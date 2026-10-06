from decimal import Decimal as D

import pytest
from alerts.chart_alert_domain import (
    Condition,
    EvaluationState,
    Indicator,
    Line,
    Observation,
    Operand,
    advance,
    line_value,
)
from pydantic import ValidationError


def comparison(relation="cross_up"):
    return Condition(relation=relation, right=Operand(kind="constant", value=10))


def observe(i, value, right=10):
    return Observation(f"sample:{i}", i, i * 1000, D(value), D(right))


@pytest.mark.parametrize("maximum", [1, 2, 3])
def test_finite_triggers_require_release_and_stop_at_limit(maximum):
    state, events = EvaluationState(), []
    # Creating above the threshold does not emit; equal releases the condition.
    for i, value in enumerate([12, 12, 10, 11, 12, 9, 11, 11, 10, 12, 9, 11]):
        state, event = advance(comparison(), state, observe(i, value), maximum)
        if event:
            events.append(event.observation.sequence)
    assert events == [3, 6, 9][:maximum]
    assert state.count == maximum


def test_same_or_older_observation_does_not_move_checkpoint_or_count():
    state, _ = advance(comparison(), EvaluationState(), observe(7, 9), 3)
    same, event = advance(comparison(), state, observe(7, 11), 3)
    assert same == state and event is None
    same, event = advance(comparison(), state, observe(6, 11), 3)
    assert same == state and event is None


def test_bidirectional_crossings_include_reverse_and_strict_equality():
    state, events = EvaluationState(), []
    for i, value in enumerate([10, 10, 11, 10, 9, 10, 11]):
        state, event = advance(comparison("cross"), state, observe(i, value), 3)
        if event:
            events.append((event.direction, event.observation.sequence))
    assert events == [("up", 2), ("down", 4), ("up", 6)]


@pytest.mark.parametrize("relation,expected", [
    ("enter", [3, 7]), ("exit", [5, 8]),
    ("break_upper", [1, 5]), ("break_lower", [2, 8]),
])
def test_interval_boundaries_and_jumps_do_not_invent_observed_prices(relation, expected):
    condition = Condition(relation=relation, lower=10, upper=20)
    state, events = EvaluationState(), []
    for i, value in enumerate([9, 21, 9, 10, 20, 21, 21, 20, 9]):
        state, event = advance(condition, state, observe(i, value), 3)
        if event:
            events.append(event.observation.sequence)
    assert events == expected


def test_comparison_uses_two_simultaneous_dynamic_values():
    condition = Condition(relation="cross_up", right=Operand(kind="indicator", indicator={
        "name": "SMA", "params": {"period": 2},
    }))
    state, _ = advance(condition, EvaluationState(), observe(0, 12, 13), 1)
    state, event = advance(condition, state, observe(1, 12, 11), 1)
    assert event.threshold == 11 and state.count == 1


def test_intrabar_return_journeys_are_separate_actual_observations():
    state, events = EvaluationState(), []
    for i, value in enumerate([9, 11, 9, 11, 9, 11]):
        sample = Observation(f"quote:{i}", i, 60_001 + i, D(value), D(10))
        state, event = advance(comparison(), state, sample, 3)
        if event:
            events.append(event.observation.occurred_at)
    assert events == [60_002, 60_004, 60_006]


def test_units_and_indicator_outputs_are_validated():
    with pytest.raises(ValidationError, match="单位"):
        Condition(relation="cross_up", right=Operand(kind="indicator", indicator={"name": "RSI"}))
    with pytest.raises(ValidationError, match="输出"):
        Indicator(name="MACD")
    with pytest.raises(ValidationError):
        Operand(kind="price", value=10)
    assert Indicator(name="EMA").params == {"period": 20}
    assert Indicator(name="MACD", output="histogram").unit == "price_delta"


def line(kind="trend_line", scale="linear", **flags):
    # A Friday/Monday gap changes wall-clock spacing, never the bar spacing.
    return Line(kind=kind, scale=scale, points=[
        {"time": 1_780_704_000_000, "index": 8, "price": 100},
        {"time": 1_780_963_200_000, "index": 10, "price": 400},
    ], **flags)


def test_line_interpolation_uses_bar_indices_and_explicit_extension():
    geometry = line()
    assert line_value(geometry, 9) == 250
    assert line_value(geometry, 7) is None
    assert line_value(geometry, 11) is None
    assert line_value(line(extend_right=True), 11) == 550
    assert line_value(line("ray"), 11) == 550
    backwards = Line(kind="ray", points=list(reversed(geometry.points)))
    assert line_value(backwards, 11) is None
    assert line_value(backwards, 7) == -50


def test_logarithmic_line_uses_geometric_interpolation():
    assert abs(line_value(line(scale="log"), 9) - D(200)) < D("1e-20")


def test_horizontal_ray_has_an_explicit_start_bar():
    geometry = Line(kind="horizontal_ray", points=[{"time": 123, "index": 8, "price": 100}])
    assert line_value(geometry, 7) is None
    assert line_value(geometry, 8) == 100


def test_invalid_observations_cannot_poison_the_baseline():
    with pytest.raises(ValueError, match="有限"):
        observe(0, "NaN")
    with pytest.raises(ValueError, match="右侧"):
        advance(comparison(), EvaluationState(), Observation("x", 0, 0, D(10)), 1)
