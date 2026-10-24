"""Native-provider RRS must use observed bars across absent trading periods."""

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from alerts.provider_indicator_inputs import Inputs, compute
from test_rolling_range_squeeze import literal_pine, matrix

META = {"calendar": "ny17", "calendar_profile": None}
SPEC = {"name": "ROLLING_RANGE_SQUEEZE"}


def native_rows(timeframe):
    interval = {"H1": timedelta(hours=1), "H4": timedelta(hours=4),
                "D1": timedelta(days=1)}[timeframe]
    moment = datetime(2023, 1, 3, 17, tzinfo=ZoneInfo("America/New_York"))
    rows = []
    while len(rows) < 780:
        following = moment + interval
        if moment.weekday() < 5 and (moment.month, moment.day) not in ((12, 25), (1, 1)):
            # Narrowing and widening ranges give an oracle with actual signals.
            width = 1 + (len(rows) % 40) / 10
            rows.append(dict(start=int(moment.timestamp() * 1000),
                             end=int(following.timestamp() * 1000), complete=True,
                             open=100, high=100 + width, low=100 - width, close=100))
        moment = following
    return rows


def provider_result(rows, timeframe, *, first=None, identity="observed-native"):
    inputs = Inputs(rows, (identity, timeframe), "frozen-history", 1)
    return compute(inputs, META, "EURUSD", SPEC,
                   first=rows[0]["start"] if first is None else first,
                   provisional=False, timeframe=timeframe)


@pytest.mark.parametrize("timeframe", ["H1", "H4", "D1"])
def test_native_squeeze_keeps_default_lookback_across_absent_periods(timeframe):
    rows = native_rows(timeframe)
    expected, segments = literal_pine(rows, 10, 252, 5)
    actual = provider_result(rows, timeframe)
    values = matrix(actual)
    assert values[-1][2] is not None, "calendar gaps must not restart the 252-ratio warmup"
    assert sum(value[2] is not None for value in values) == len(rows) - 261
    for value, oracle in zip(values, expected, strict=True):
        assert value == pytest.approx(oracle, abs=1e-12)
    labels = actual["presentation"]["labels"]
    boxes = actual["presentation"]["boxes"]
    assert len(labels) == len(segments) > 0
    assert len(boxes) == sum(1 + (s["right"] > s["first"]) for s in segments)
    for segment, label in zip(segments, labels, strict=True):
        assert label["time"] == rows[segment["first"]]["start"]
        assert label["pct_rank"] == segment["rank"]
        for box in (b for b in boxes if b["first"] == label["time"]):
            assert box["left"] == rows[segment["left"]]["start"]
            assert (box["top"], box["bottom"]) == (segment["top"], segment["bottom"])
            right = segment["first"] if box["kind"] == "first" else segment["right"]
            assert box["right"] == rows[right]["start"]

    # The provider result cache retains the full drawing history during paging.
    paged = provider_result(rows, timeframe, first=rows[-100]["start"])
    assert matrix(paged) == values[-100:]
    assert paged["presentation"] == actual["presentation"]


@pytest.mark.parametrize("invalid", [{"gap_before": True}, {"complete": False}])
def test_native_squeeze_still_resets_on_explicit_invalid_input(invalid):
    rows = native_rows("D1")
    rows[400].update(invalid)
    result = provider_result(rows, "D1", identity=str(invalid))
    values = matrix(result)
    assert values[399][2] is not None
    assert values[400][2] is None
    first = 401 if invalid.get("complete") is False else 400
    oracle, _ = literal_pine(rows[first:], 10, 252, 5)
    for value, expected in zip(values[first:], oracle, strict=True):
        assert value == pytest.approx(expected, abs=1e-12)
