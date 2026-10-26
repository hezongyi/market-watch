"""Source-rule parity, checkpoint isolation and actual chart execution paths."""

import copy
import hashlib
import json
from pathlib import Path

import pytest
from alerts.chart_indicators import calculate, public_catalog, validate
from alerts.indicator_state import IndicatorState
from alerts.nr_breakout import NAME, OUTPUTS
from alerts.observed_indicators import ObservedState

DAY = 86400000
SPEC = {"name": NAME}


def bars(widths, closes=None, *, step=DAY):
    return [{"start": i * step, "end": (i + 1) * step, "open": 10.,
             "high": 10 + width / 2, "low": 10 - width / 2,
             "close": 10. if closes is None else closes[i], "complete": True}
            for i, width in enumerate(widths)]


def columns(result):
    return {s["key"]: [p["value"] for p in s["values"]] for s in result["series"]}


def source_oracle(rows, pattern="NR4/NR7"):
    """Literal Pine series evaluation, independent of production state helpers.

    Aggregate D candles first, map [1] to child candles, then execute the Pine
    assignments and ta.cross* comparisons in source order.
    """
    groups = {}
    for row in rows:
        groups.setdefault(row["start"] // DAY, []).append(row)
    security = {}
    widths = []
    previous = None
    for day, members in groups.items():
        security[day] = previous
        high, low = max(r["high"] for r in members), min(r["low"] for r in members)
        widths.append(high - low)
        nr7 = pattern != "NR4" and widths[-1] == min(widths[-7:])
        nr4 = pattern != "NR7" and widths[-1] == min(widths[-4:]) and not nr7
        previous = (nr4, nr7, high, low, members[0]["start"])
    output = {key: [] for key in OUTPUTS}
    rh = rl = old_rh = old_rl = old_close = None
    up_check = down_check = up_fired = down_fired = False
    old_day = line_start = line_end = None
    box = None
    for row in rows:
        day = row["start"] // DAY
        nr4, nr7, high, low, box_start = security[day] or (False, False, None, None, None)
        nr = nr4 or nr7
        if nr:
            rh, rl = high, low
        mid = None if rh is None else (rh + rl) / 2
        if day != old_day and nr:
            up_check = down_check = True
            line_start = line_end = row["start"]
            box = (rh, rl, 4 if nr4 else 7, box_start, row["start"])
        if day != old_day:
            up_fired = down_fired = False
            if not nr:
                box = None
        down = up = None
        close = row["close"]
        if mid is not None:
            if close > mid and not down_check:
                down_check = True
            if old_rl is not None and close < rl and old_close >= old_rl and down_check:
                down, down_check, down_fired = rh, False, True
            if close < mid and not up_check:
                up_check = True
            if old_rh is not None and close > rh and old_close <= old_rh and up_check:
                up, up_check, up_fired = rl, False, True
        if nr or up_fired or down_fired:
            line_end = row["start"]
        values = [rh, rl, mid, line_start, line_end, *(box or [None] * 5), up, down,
                  groups[day][0]["start"]]
        for key, value in zip(OUTPUTS, values):
            output[key].append(value)
        old_day, old_rh, old_rl, old_close = day, rh, rl, close
    return output


@pytest.mark.parametrize("pattern", ["NR4/NR7", "NR4", "NR7"])
def test_literal_pine_oracle_partial_warmup_ties_prior_boundaries_and_rearming(pattern):
    rows = bars([8, 7, 9, 6, 7, 8, 4, 7, 8, 9, 3, 6, 9, 10, 3, 8],
                [10, 10, 10, 9, 12, 10, 10, 13, 9, 13, 10, 8, 11, 8, 10, 13])
    spec = {"name": NAME, "params": {"pattern_type": pattern}}
    assert columns(calculate(rows, spec)) == source_oracle(rows, pattern)
    state = IndicatorState(spec)
    actual = []
    for row in rows:
        state = IndicatorState(spec, json.loads(json.dumps(state.checkpoint(), allow_nan=False)))
        actual.append(state.step(row))
    assert {key: [r[key] for r in actual] for key in OUTPUTS} == source_oracle(rows, pattern)


def test_first_available_range_counts_and_nr4_only_does_not_exclude_nr7():
    rows = bars([4, 4, 4])
    combo = columns(calculate(rows, SPEC))
    assert combo["pattern_type"] == [None, 7, 7]
    assert combo["range_high"] == [None, 12, 12]
    nr4 = columns(calculate(rows, {"name": NAME, "params": {"pattern_type": "NR4"}}))
    assert nr4["pattern_type"] == [None, 4, 4]


def test_intraday_no_lookahead_and_signal_rearms_only_beyond_midline():
    rows = bars([4, 4, 4, 4, 8, 10, 10, 10, 10, 10, 10, 10], step=DAY // 4)
    for row, close in zip(rows, [10, 10, 10, 10, 10, 13, 11, 13, 9, 13, 7, 7]):
        row["close"] = close
        row["high"] = max(row["high"], close)
        row["low"] = min(row["low"], close)
    actual = columns(calculate(rows, SPEC))
    assert actual == source_oracle(rows)
    assert actual["up_signal"] == [None] * 5 + [8, None, None, None, 8, None, None]
    assert actual["down_signal"][-2:] == [12, None]
    assert actual["pattern_start"][4] == 0
    assert actual["pattern_end"][4] == DAY
    # Future high/low changes cannot rewrite an already-confirmed output.
    for cut in range(1, len(rows)):
        prefix = columns(calculate(rows[:cut], SPEC))
        assert prefix == {key: values[:cut] for key, values in actual.items()}


def test_no_pattern_period_freezes_lines_but_does_not_disable_later_signals():
    rows = bars([4, 8, 10, 12], [10, 10, 13, 10])
    result = columns(calculate(rows, SPEC))
    assert result["range_end"] == [None, DAY, 2 * DAY, 2 * DAY]
    assert result["up_signal"] == [None, None, 8, None]


def test_confirmed_and_provisional_are_retractable_and_json_checkpoint_is_bounded():
    rows = bars([4, 8, 10])
    engine = IndicatorState(SPEC)
    for row in rows[:2]:
        engine.step(row)
    original = engine.checkpoint()
    for close, expected in [(13, 8), (10, None), (13, 8)]:
        row = rows[2] | {"close": close, "high": 15, "complete": False}
        assert engine.step(row, provisional=True)["up_signal"] == expected
        assert engine.checkpoint() == original
        assert columns(calculate([*rows[:2], row], SPEC, provisional=True))["up_signal"][-1] == expected
    for row in bars([4] * 3000):
        engine.step(row)
    assert len(json.dumps(engine.checkpoint(), allow_nan=False)) < 2500


def test_gap_and_incomplete_restart_batch_state_and_observed_gap_keeps_prices():
    rows = bars([4] * 10)
    rows[3]["gap_before"] = True
    rows[6]["complete"] = False
    original = copy.deepcopy(rows)
    engine = IndicatorState(SPEC)
    actual = [engine.step(row) for row in rows]
    assert {key: [r[key] for r in actual] for key in OUTPUTS} == columns(calculate(rows, SPEC))
    assert actual[3]["range_high"] is None and actual[6]["range_high"] is None
    observed = ObservedState(SPEC)
    actual = [observed.step(row) for row in rows]
    expected = columns(calculate([{**r, "complete": True, "gap_before": False} for r in rows], SPEC))
    assert {key: [r[key] for r in actual] for key in OUTPUTS} == expected
    assert observed.last_quality["coverage"] == "unverified"
    assert rows == original


def test_ny17_dst_daily_and_chart_coordinates_are_preserved():
    from datetime import datetime

    def time(value):
        return int(datetime.fromisoformat(value).timestamp() * 1000)

    rows = [{"start": time(left), "end": time(right), "high": 12., "low": 8., "close": 10., "complete": True,
             "indicator_calendar": "ny17", "chart_time": i * DAY}
            for i, (left, right) in enumerate([
                ("2026-03-06T22:00:00+00:00", "2026-03-07T22:00:00+00:00"),
                ("2026-03-08T21:00:00+00:00", "2026-03-09T21:00:00+00:00"),
                ("2026-03-09T21:00:00+00:00", "2026-03-10T21:00:00+00:00"),
            ])]
    result = columns(calculate(rows, SPEC))
    assert result["pattern_start"] == [None, 0, DAY]
    assert result["pattern_end"] == [None, DAY, 2 * DAY]


@pytest.mark.parametrize("timeframe", ["1", "5", "15", "30", "60", "240", "D", "W", "M"])
def test_all_declared_timeframes(timeframe):
    rows = bars([4] * 60, step=60000)
    result = calculate(rows, {"name": NAME, "params": {"timeframe": timeframe}})
    assert len(result["series"][0]["values"]) == len(rows)


def test_lower_or_misaligned_timeframe_is_explicitly_rejected():
    with pytest.raises(ValueError, match="形态周期"):
        calculate(bars([4]), {"name": NAME, "params": {"timeframe": "60"}})


def millis(value):
    from datetime import datetime

    return int(datetime.fromisoformat(value).timestamp() * 1000)


@pytest.mark.parametrize("date,offset", [("2026-03-06", "-05:00"), ("2026-03-09", "-04:00")])
def test_yahoo_hourly_period_anchors_to_exchange_open_across_dst(date, offset):
    from alerts.nr_breakout import bucket

    row = {"start": millis(f"{date}T10:30:00{offset}"), "end": millis(f"{date}T11:30:00{offset}"),
           "indicator_calendar": "yahoo", "indicator_timezone": "America/New_York",
           "indicator_session": "0930-1600:23456", "indicator_timeframe": "H1"}
    assert bucket(row, {"timeframe": "240"}) == (
        millis(f"{date}T09:30:00{offset}"), millis(f"{date}T13:30:00{offset}"))


def test_yahoo_overnight_session_and_source_weekly_holiday_boundaries():
    from alerts.nr_breakout import bucket

    row = {"start": millis("2026-03-08T18:00:00-04:00"), "end": millis("2026-03-08T19:00:00-04:00"),
           "indicator_calendar": "yahoo", "indicator_timezone": "America/New_York",
           "indicator_session": "1800-1700:23456", "indicator_timeframe": "H1"}
    assert bucket(row, {"timeframe": "D"}) == (
        millis("2026-03-08T18:00:00-04:00"), millis("2026-03-09T18:00:00-04:00"))
    # Yahoo's first week after Labor Day can be labelled Tuesday. Equal-TF
    # calculation must use that exact source bar instead of rejecting its end.
    row.update(start=millis("2026-09-08T00:00:00-04:00"),
               end=millis("2026-09-15T00:00:00-04:00"), indicator_timeframe="W1")
    assert bucket(row, {"timeframe": "W"}) == (row["start"], row["end"])


@pytest.mark.parametrize("policy", ["strict_confirmed_v1", "observed_display_v1"])
def test_fixed_worker_checkpoint_and_historical_pagination_match_batch(database, monkeypatch, policy):
    from alerts import fixed_indicators as jobs
    from alerts.chart_calculation_history import calculation_rows
    from alerts.chart_query import DataQuery, data_sync
    from alerts.history_artifacts import read_artifact
    from alerts.storage import FixedIndicatorRun
    from test_fixed_indicators import drain, history

    version = history(database, monkeypatch, count=160)
    monkeypatch.setattr(jobs, "PAGE_SIZE", 37)  # Split inside an HTF candle.
    spec = {"name": NAME, "params": {"timeframe": "5"}}
    query = DataQuery(instrument=version, series_kind="history", timeframe="M1", limit=17,
                      indicators=[spec], indicator_input_policy=policy)
    pending = data_sync(query)
    ident = pending["indicator_progress"][0]["run_id"]
    drain(ident)
    with database.begin() as db:
        source = read_artifact(db, version, "M1", limit=1000)
        run = db.get(FixedIndicatorRun, ident)
        assert run.status == "complete"
        assert "nr4-nr7-breakout-state-v1" in run.algorithm
    expected = calculate(calculation_rows(source, {"calendar": "utc0"}, version, "M1"), spec)
    actual = data_sync(query)
    assert not actual["pending"]
    assert len(actual["indicators"][0]["series"]) == len(OUTPUTS)
    for series, reference in zip(actual["indicators"][0]["series"], expected["series"]):
        assert series["values"] == reference["values"][-17:]
    older = data_sync(query.model_copy(update={"before": actual["bars"][0]["start"]}))
    assert older["indicator_progress"][0]["run_id"] == ident
    for series, reference in zip(older["indicators"][0]["series"], expected["series"]):
        assert series["values"] == reference["values"][-34:-17]


@pytest.mark.parametrize("policy", ["strict_confirmed_v1", "observed_display_v1"])
def test_source_date_daily_fixed_worker_and_pagination_match_pine(database, monkeypatch, policy):
    from alerts import fixed_indicators as jobs
    from alerts.chart_query import DataQuery, data_sync
    from alerts.history_artifacts import read_artifact
    from test_fixed_indicators import drain
    from test_native_history_archive import Adapter, day, prepare, run

    dataset = prepare(database, mode="native_periods", outputs=("D1",))
    source = [day(date, high=str(10 + width / 2), low=str(10 - width / 2), close="10")
              for date, width in zip(("2024-01-02", "2024-01-04", "2024-01-05", "2024-01-08"),
                                     (8, 7, 9, 6))]
    version = run(database, dataset, "2024-01-09", Adapter({"D1": source}))
    monkeypatch.setattr(jobs, "PAGE_SIZE", 2)
    query = DataQuery(instrument=version, series_kind="history", timeframe="D1", limit=2,
                      indicators=[SPEC], indicator_input_policy=policy)
    pending = data_sync(query)
    ident = pending["indicator_progress"][0]["run_id"]
    drain(ident)
    with database.begin() as db:
        source = read_artifact(db, version, "D1", limit=1000)
    expected = columns(calculate(source, SPEC))
    actual = data_sync(query)
    assert not actual["pending"]
    for series in actual["indicators"][0]["series"]:
        assert [point["value"] for point in series["values"]] == expected[series["key"]][-2:]
    older = data_sync(query.model_copy(update={"before": actual["bars"][0]["start"]}))
    assert older["indicator_progress"][0]["run_id"] == ident
    for series in older["indicators"][0]["series"]:
        assert [point["value"] for point in series["values"]] == expected[series["key"]][:-2]


@pytest.mark.parametrize("timeframe,expected", [
    ("W", ("2024-01-01", "2024-01-08")),
    ("M", ("2024-01-01", "2024-02-01")),
])
def test_source_date_higher_pattern_uses_explicit_trading_date(timeframe, expected):
    from alerts.nr_breakout import bucket

    row = {"start": millis("2024-01-04T00:00:00+00:00"),
           "end": millis("2024-01-04T07:10:00+00:00"), "trading_date": "2024-01-04",
           "indicator_calendar": "source_date", "indicator_timeframe": "D1"}
    assert bucket(row, {"timeframe": timeframe}) == tuple(
        millis(date + "T00:00:00+00:00") for date in expected)


def test_source_date_native_same_frame_keeps_source_boundaries_and_does_not_infer_night_date():
    from alerts.nr_breakout import bucket

    row = {"start": millis("2024-01-02T00:00:00+00:00"),
           "end": millis("2024-01-09T00:00:00+00:00"),
           "indicator_calendar": "source_date", "indicator_timeframe": "W1"}
    assert bucket(row, {"timeframe": "W"}) == (row["start"], row["end"])
    row.update(indicator_timeframe="M5", end=row["start"] + 300000)
    with pytest.raises(ValueError, match="交易日"):
        bucket(row, {"timeframe": "D"})


@pytest.mark.parametrize("params", [{"timeframe": "H1"}, {"pattern_type": "NR5"}, {"timeframe": 60}, {"show_signals": False}])
def test_invalid_params(params):
    with pytest.raises(ValueError):
        validate({"name": NAME, "params": params})


def test_catalog_identity_license_and_reference_provenance():
    meta = public_catalog()[NAME]
    assert meta["source"] == "Python" and meta["params"] == {"timeframe": "D", "pattern_type": "NR4/NR7"}
    assert [s["key"] for s in meta["series"]] == list(OUTPUTS)
    assert "CC BY-NC-SA 4.0" in meta["calculation"]
    reference = Path(__file__).parents[2] / "docs/references/nr4-nr7-luxalgo.pine"
    assert hashlib.sha256(reference.read_bytes()).hexdigest() == "84e15423015effdd055f77210800fadbfc94f9970e86931db22d2ecced684917"
