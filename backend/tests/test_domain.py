from datetime import UTC, datetime, timedelta
from decimal import Decimal as D

import pytest
from alerts.domain import (
    Calendar,
    Candle,
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
