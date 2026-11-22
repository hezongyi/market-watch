"""PAIO preserves actual native phases, and discloses unknown projections.

These source-contract fixtures are independent of a TradingView runtime oracle.
FXCM phase examples follow the recorded native-session-samples.json evidence.
"""

from datetime import datetime

import pytest
from alerts.chart_indicators import calculate as chart_calculate
from alerts.chart_indicators import validate
from alerts.paio_inputs import (
    PaioCalendarUnavailable,
    attach,
    boundaries,
    chart_coordinate,
    requests,
)


def stamp(value):
    return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)


def candle(start, end, *, frame="M1", calendar="fxcm_native", periods=None):
    return dict(start=start, end=end, open="1.1", high="1.2", low="1.0", close="1.1",
                complete=True, chart_time=start, indicator_timeframe=frame,
                indicator_calendar=calendar, indicator_native_periods=periods or {})


def calculate(rows, spec):
    _, params = validate(spec)
    frozen = dict(frames={frame: dict(rows=bars, revision=1)
        for frame, bars in rows[0]["indicator_native_periods"].items()})
    prepared = attach(rows, params, frozen, chart_frame=rows[0]["indicator_timeframe"])
    return chart_calculate(prepared, spec)


def test_native_boundary_dependencies_are_requested_even_for_chart_based_pv():
    spec = dict(name="PAIO_V1")
    assert requests([spec], "M1") == ["H1", "M15"]
    assert requests([spec], "M1", calendar="dukascopy_native_utc") == ["D1", "H1", "M15"]
    assert requests([spec], "M1", calendar="fxcm_native") == ["D1", "H1", "M15"]
    assert requests([spec], "D1", calendar="fxcm_native") == ["H1", "M15"]


@pytest.mark.parametrize("frame,token,start,end", [
    ("D1", "1D", "2026-11-20T00:00:00Z", "2026-11-21T00:00:00Z"),
    # A source weekly anchor is not silently rounded to Monday.
    ("W1", "1W", "2026-11-15T00:00:00Z", "2026-11-22T00:00:00Z"),
    ("MN", "1M", "2024-02-01T00:00:00Z", "2024-03-01T00:00:00Z"),
    ("MN", "1M", "2026-12-01T00:00:00Z", "2027-01-01T00:00:00Z"),
])
def test_dukascopy_keeps_native_starts_and_adapter_interval_ends(frame, token, start, end):
    bar = candle(stamp(start), stamp(end), frame=frame, calendar="dukascopy_native_utc")
    assert boundaries(bar, token) == (stamp(start), stamp(end), None)
    assert chart_coordinate(stamp(start), bar) == stamp(start)


def test_fxcm_h4_uses_actual_21_hour_phase_not_midnight_grid():
    start, end = stamp("2026-10-20T21:00:00Z"), stamp("2026-10-21T01:00:00Z")
    native = candle(start, end, frame="H4")
    row = candle(start + 3600000, start + 3660000, periods={"H4": [native]})
    assert boundaries(row, "240") == (start, end, None)


def test_fxcm_daily_dst_uses_observed_starts_and_leaves_future_close_unknown():
    # 25-hour session across the NY autumn offset transition.
    start, following = stamp("2026-10-31T21:00:00Z"), stamp("2026-11-01T22:00:00Z")
    bars = [candle(start, following, frame="D1"), candle(following, following + 25*3600000, frame="D1")]
    row = candle(start + 3600000, start + 3660000, periods={"D1": bars})
    assert boundaries(row, "1D") == (start, following, None)
    row = candle(following + 3600000, following + 3660000, periods={"D1": bars})
    assert boundaries(row, "1D") == (following, None, None)


@pytest.mark.parametrize("frame,token,start,following", [
    ("W1", "1W", "2026-10-17T21:00:00Z", "2026-10-24T21:00:00Z"),
    ("MN", "1M", "2026-08-31T21:00:00Z", "2026-09-30T21:00:00Z"),
])
def test_fxcm_week_and_month_preserve_recorded_broker_labels(frame, token, start, following):
    left, right = stamp(start), stamp(following)
    bars = [candle(left, right, frame=frame), candle(right, right + 32*86400000, frame=frame)]
    row = candle(left + 3600000, left + 3660000, periods={frame: bars})
    assert boundaries(row, token) == (left, right, None)
    assert chart_coordinate(left, row | dict(indicator_timeframe=frame)) == left


def test_fxcm_weekend_and_elapsed_upper_bound_do_not_invent_a_daily_close():
    start, following = stamp("2026-10-22T21:00:00Z"), stamp("2026-10-25T21:00:00Z")
    bars = [candle(start, start + 25*3600000, frame="D1"), candle(following, following + 25*3600000, frame="D1")]
    row = candle(start + 3600000, start + 3660000, periods={"D1": bars})
    assert boundaries(row, "1D") == (start, None, None)
    with pytest.raises(PaioCalendarUnavailable):
        boundaries(row | dict(start=start + 48*3600000, end=start + 48*3600000 + 60000), "1D")


@pytest.mark.parametrize("calendar", ["dukascopy_native_utc", "fxcm_native"])
def test_missing_native_period_does_not_disable_unrelated_paio_modules(calendar):
    rows = [candle(index*60000, (index+1)*60000, calendar=calendar) | dict(
        low=1 + index*.01, high=2 - index*.01, open=1.5, close=1.5) for index in range(3)]
    result = calculate(rows, dict(name="PAIO_V1"))
    values = {series["key"]: series["values"][-1]["value"] for series in result["series"]}
    assert values["pattern_ii"] == 1 and values["ema_1"] == 1.5
    assert values["specific_bar"] is None and values["pv_1"] is None
    presentation = result["presentation"]
    assert not presentation["readiness"]["bar_index"]
    assert presentation["readiness_reasons"]["bar_index"] == "NATIVE_PERIOD_NOT_LOADED"
    assert presentation["readiness"]["io"]


def test_fxcm_default_all_computes_pv_but_discloses_unknown_future_line_endpoint():
    first, second = stamp("2026-11-18T22:00:00Z"), stamp("2026-11-19T22:00:00Z")
    periods = [candle(first, second, frame="D1"), candle(second, second + 25*3600000, frame="D1")]
    rows = [candle(first + 60000, first + 120000, periods={"D1": periods}),
            candle(second + 60000, second + 120000, periods={"D1": periods})]
    result = calculate(rows, dict(name="PAIO_V1"))
    assert next(series for series in result["series"] if series["key"] == "pv_1")["values"][-1]["value"] == 1.1
    assert result["presentation"]["readiness"]["pv_1"]
    assert result["presentation"]["readiness_reasons"]["pv_1_line"] == "NEXT_NATIVE_CLOSE_UNVERIFIED"
    assert not any(obj["kind"] == "line" for obj in result["presentation"]["objects"])


def test_fxcm_timeframe_filter_reports_unknown_close_instead_of_comparing_null():
    start = stamp("2026-11-19T22:00:00Z")
    periods = [candle(start, start + 25*3600000, frame="D1")]
    row = candle(start + 60000, start + 120000, periods={"D1": periods})
    result = calculate([row], dict(name="PAIO_V1", params=dict(pvDisplay="TimeFrame")))
    assert result["presentation"]["readiness_reasons"]["pv_1"] == "NATIVE_CLOSE_UNVERIFIED"
    assert result["presentation"]["readiness"]["bar_index"]


def test_native_known_successor_projection_keeps_source_coordinates():
    starts = [stamp(f"2026-11-{day}T00:00:00Z") for day in (18, 19, 20)]
    periods = [candle(value, value + 86400000, frame="D1", calendar="dukascopy_native_utc") for value in starts]
    rows = [candle(value + 60000, value + 120000, calendar="dukascopy_native_utc", periods={"D1": periods}) for value in starts[:2]]
    result = calculate(rows, dict(name="PAIO_V1"))
    line = next(obj for obj in result["presentation"]["objects"] if obj["module"] == "pv1st")
    assert line["left"] == starts[1] + 60000 and line["right"] == starts[2] + 86400000


def test_configured_oanda_native_calendar_uses_actual_periods_and_chart_labels():
    from alerts.native_series import chart_label
    from alerts.paio_inputs import chart_coordinate
    opening=stamp("2026-11-19T08:00:00Z")
    periods=[candle(opening,opening+86400000,frame="D1",calendar="native")]
    row=candle(opening+60000,opening+120000,calendar="native",periods={"D1":periods})
    assert boundaries(row,"1D")[:2]==(opening,opening+86400000)
    values=dict(price="B",smooth=False,dailyAlignment=8,alignmentTimezone="UTC",weeklyAlignment="Monday")
    chart_row={**row,"indicator_timeframe":"D1","indicator_native_parameters":values}
    assert chart_coordinate(opening,chart_row)==chart_label(opening,"D1",values)


@pytest.mark.parametrize("chart_frame",["M1","D1"])
def test_native_new_successor_rebuilds_earlier_projection_objects(chart_frame):
    from alerts.provider_indicator_inputs import Inputs, compute
    day=86400000
    opening=stamp("2026-11-16T22:00:00Z")
    values=[candle(opening+i*day,opening+(i+1)*day+(3600000 if i==2 else 0),frame="D1") for i in range(3)]
    spec=dict(name="PAIO_V1")
    for size in (3,4):
        if size==4:
            values[-1]={**values[-1],"end":opening+3*day}
            values.append(candle(opening+3*day,opening+4*day+3600000,frame="D1"))
        rows=values if chart_frame=="D1" else [candle(bar["start"]+60000,bar["start"]+120000) for bar in values]
        frozen=dict(frames={"D1":dict(rows=list(values),revision=size,epoch="stable",origin=opening)})
        actual=compute(Inputs(rows,("native-boundary",chart_frame),"stable",size,frozen),
            dict(calendar="fxcm_native"),"FXCM:TEST",spec,first=opening,provisional=False,timeframe=chart_frame)
        # Independent complete replay of the exact same source observation.
        expected=chart_calculate(attach(rows,validate(spec)[1],frozen,chart_frame=chart_frame),spec)
        assert actual["presentation"]["objects"]==expected["presentation"]["objects"]
        if size==4:
            assert any(obj["kind"]=="line" for obj in actual["presentation"]["objects"])
