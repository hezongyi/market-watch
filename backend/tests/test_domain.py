from datetime import UTC, datetime, timedelta
from decimal import Decimal as D

import pytest
from alerts.domain import (
    Calendar,
    Candle,
    Rule,
    State,
    advance,
    aggregate,
    bucket_bounds,
    session_bounds,
)

START = datetime(2026, 1, 5, tzinfo=UTC)


def bar(i, o, h, low, c):
    return Candle(
        START + timedelta(hours=4 * i),
        START + timedelta(hours=4 * (i + 1)),
        *map(lambda x: D(str(x)), (o, h, low, c)),
    )


def test_pullback_waits_multiple_bars_and_emits_only_first_opportunity():
    rows = [
        bar(0, 10, 11, 8, 9),
        bar(1, 9, 10, 7, 8),
        bar(2, 8, 9, 7, 8.5),
        bar(3, 8.5, 10, 8, 9.5),
    ]
    state, rule = State(), Rule("pullback", direction="buy")
    out = [advance(rule, state, b, armed_at=START) for b in rows]
    assert out[:3] == [None, None, None]
    assert out[3].threshold == D(9)
    assert not state.buy_ready


def test_historical_break_consumes_ready_state_without_notification():
    state, rule = State(), Rule("pullback", direction="buy")
    for b in [bar(0, 10, 11, 8, 9), bar(1, 9, 10, 7, 8), bar(2, 8, 12, 7, 11)]:
        assert advance(rule, state, b) is None
    assert not state.buy_ready
    assert advance(rule, state, bar(3, 11, 14, 10, 13), armed_at=START) is None


def test_sell_mirror_three_candles_and_strict_threshold():
    rule, state = Rule("pullback", direction="sell", consecutive=3), State()
    for b in [bar(0, 8, 10, 7, 9), bar(1, 9, 11, 8, 10), bar(2, 10, 12, 9, 11)]:
        advance(rule, state, b)
    assert state.sell_ready
    assert advance(rule, state, bar(3, 11, 12, 8, 9), armed_at=START) is None
    signal = advance(rule, state, bar(4, 9, 10, 6, 7), armed_at=START)
    assert signal.direction == "sell" and signal.threshold == 8


def test_doji_interrupts_formation_but_not_already_ready():
    rule, state = Rule("pullback"), State()
    for b in [bar(0, 10, 11, 8, 9), bar(1, 9, 10, 7, 9), bar(2, 9, 10, 6, 8)]:
        advance(rule, state, b)
    assert state.down_count == 1 and not state.buy_ready


def test_lower_lows_required_not_just_red_bars():
    state, rule = State(), Rule("pullback")
    advance(rule, state, bar(0, 10, 11, 7, 9))
    advance(rule, state, bar(1, 9, 10, 7, 8))
    assert not state.buy_ready


def test_previous_day_requires_fresh_cross():
    day = Candle(START - timedelta(days=1), START, D(9), D(10), D(5), D(9))
    state, rule = State(), Rule("previous_day", timeframe="M5")
    advance(rule, state, bar(0, 11, 13, 10, 12), previous_day=day)
    assert advance(rule, state, bar(1, 12, 14, 11, 13), previous_day=day, armed_at=START) is None
    advance(rule, state, bar(2, 13, 14, 8, 9), previous_day=day, armed_at=START)
    assert (
        advance(rule, state, bar(3, 9, 12, 8, 11), previous_day=day, armed_at=START).threshold == 10
    )


def test_no_future_daily_context():
    rule, state = Rule("previous_day"), State()
    with pytest.raises(ValueError, match="completed"):
        advance(rule, state, bar(0, 9, 10, 8, 9), previous_day=bar(1, 9, 10, 8, 9))


def test_equal_armed_boundary_does_not_emit():
    state, rule = State(), Rule("price", level=D(10))
    advance(rule, state, bar(0, 9, 10, 8, 9))
    current = bar(1, 9, 12, 8, 11)
    assert advance(rule, state, current, armed_at=current.end) is None


def test_timezone_and_h4_anchor():
    winter = datetime(2026, 1, 6, 1, tzinfo=UTC)
    summer = datetime(2026, 7, 6, 1, tzinfo=UTC)
    assert session_bounds(winter, Calendar.NY17)[0].hour == 22
    assert session_bounds(summer, Calendar.NY17)[0].hour == 21
    assert bucket_bounds(winter, "H4", Calendar.NY17)[0].hour == 22
    assert bucket_bounds(summer, "H4", Calendar.NY17)[0].hour == 1
    assert session_bounds(summer, Calendar.UTC0)[0].hour == 0


def test_dst_and_end_exclusivity():
    before = datetime(2026, 3, 8, 6, tzinfo=UTC)
    left, right = session_bounds(before, Calendar.NY17)
    assert right - left == timedelta(hours=23)
    assert session_bounds(right, Calendar.NY17)[0] == right


def test_autumn_dst_session_has_25_hours_and_exclusive_end():
    before = datetime(2026, 11, 1, 6, tzinfo=UTC)
    left, right = session_bounds(before, Calendar.NY17)
    assert left == datetime(2026, 10, 31, 21, tzinfo=UTC)
    assert right == datetime(2026, 11, 1, 22, tzinfo=UTC)
    assert right - left == timedelta(hours=25)
    assert session_bounds(right, Calendar.NY17)[0] == right


def test_aggregate_missing_minute_not_complete():
    expected = {START + timedelta(minutes=i) for i in range(5)}
    rows = [
        Candle(t, t + timedelta(minutes=1), D(9), D(11), D(8), D(10)) for t in sorted(expected)[:-1]
    ]
    result = aggregate(rows, START, START + timedelta(minutes=5), expected_starts=expected)
    assert not result.complete
    with pytest.raises(ValueError, match="incomplete"):
        advance(Rule("pullback"), State(), result)


def test_aggregate_exact_ohlc_and_duplicate_guard():
    expected = {START, START + timedelta(minutes=1)}
    rows = [
        Candle(START, START + timedelta(minutes=1), D(9), D(12), D(8), D(10)),
        Candle(
            START + timedelta(minutes=1), START + timedelta(minutes=2), D(10), D(11), D(7), D(8)
        ),
    ]
    result = aggregate(rows, START, START + timedelta(minutes=2), expected_starts=expected)
    assert (result.open, result.high, result.low, result.close) == (D(9), D(12), D(7), D(8))
    assert result.complete
    with pytest.raises(ValueError, match="Duplicate"):
        aggregate(rows + rows, START, START + timedelta(minutes=2), expected_starts=expected)


@pytest.mark.parametrize("level", ["NaN", "Infinity", "-1", "0"])
def test_invalid_price(level):
    with pytest.raises(ValueError):
        Rule("price", level=D(level))
