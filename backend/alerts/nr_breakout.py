"""LuxAlgo NR4 & NR7 with Breakouts, translated from the supplied Pine v5.

Original © LuxAlgo, CC BY-NC-SA 4.0. This adaptation retains that license.
See docs/references/nr4-nr7-luxalgo.pine for the unchanged source.
Prices, pattern confirmation, crossing state and drawing coordinates are all
computed here; the chart adapter only renders the returned numerical records.
"""

import copy
import math
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

NAME = "NR4_NR7_BREAKOUT_V1"
ALGORITHM = "nr4-nr7-breakout-state-v1"
OUTPUTS = (
    "range_high", "range_low", "range_mid", "range_start", "range_end",
    "pattern_high", "pattern_low", "pattern_type", "pattern_start", "pattern_end",
    "up_signal", "down_signal",
    "period_start",
)
TIMEFRAMES = ("1", "5", "15", "30", "60", "240", "D", "W", "M")
FRAMES = dict(zip(TIMEFRAMES, ("M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN")))
PATTERNS = ("NR4/NR7", "NR4", "NR7")
METADATA = {
    "label": "NR4/NR7 窄幅突破（LuxAlgo）",
    "aliases": ["NR4", "NR7", "Narrow Range", "Breakouts", "LuxAlgo", NAME],
    "description": "复现 LuxAlgo NR4/NR7 形态框、区间中线及可重新触发的突破信号。",
    "calculation": "仅用上一已结束形态周期的高低差（并列最小也成立）；组合模式 NR7 优先。收盘穿越边界后，回到中线另一侧可重新触发。© LuxAlgo，CC BY-NC-SA 4.0。",
    "pane": "main",
    "params": {"timeframe": "D", "pattern_type": "NR4/NR7"},
    "parameter_schema": {
        "timeframe": {"type": "enum", "options": list(TIMEFRAMES), "default": "D", "label": "形态周期（不低于图表周期）"},
        "pattern_type": {"type": "enum", "options": list(PATTERNS), "default": "NR4/NR7", "label": "形态类型"},
    },
    "series": [{"key": key, "type": "line"} for key in OUTPUTS],
    "render_profile": "nr_breakout_v1",
    "display_inputs": [
        {"id": "show_signals", "name": "Show Breakout Signals", "type": "bool", "default": True},
        {"id": "signal_size", "name": "Signal Size", "type": "text", "default": "Small",
         "options": ["Tiny", "Small", "Normal", "Large", "Huge"]},
        {"id": "up_color", "name": "Up Color", "type": "color", "default": "#089981"},
        {"id": "down_color", "name": "Down Color", "type": "color", "default": "#f23645"},
        {"id": "nr4_color", "name": "NR4 Pattern", "type": "color", "default": "rgba(102, 187, 106, 0.3)"},
        {"id": "nr7_color", "name": "NR7 Pattern", "type": "color", "default": "rgba(255, 238, 88, 0.3)"},
        {"id": "range_color", "name": "Range Color", "type": "color", "default": "#787b86"},
    ],
    # Pine ta.lowest ignores unavailable prefix values; it does not require
    # four/seven complete candles before its first pattern.
    "history_requirement": lambda p: 1,
}


def empty():
    return dict.fromkeys(OUTPUTS)


def bucket(row, params):
    from .composite_series import period

    frame = FRAMES[params["timeframe"]]
    if row.get("indicator_timeframe") == frame:
        # Source W/M candles may start on a holiday-delayed trading day. Their
        # source boundaries, not a reconstructed Monday, define equal TF input.
        return row["start"], row["end"]
    if row.get("indicator_calendar") == "yahoo":
        left, right = yahoo_period(row, params["timeframe"])
    else:
        left, right = period(row["start"], frame, row.get("indicator_calendar", "utc0"))
    # A chart candle cannot reconstruct an interior HTF boundary. Reject this
    # explicitly rather than silently calculating a different pattern.
    if row["end"] > right:
        raise ValueError(f"{NAME}: 形态周期必须不低于图表周期，且周期边界须对齐")
    return left, right


def yahoo_period(row, timeframe):
    """Exchange-local sessions; retain Yahoo's source trading-date convention."""
    if not row.get("indicator_timezone"):
        raise ValueError(f"{NAME}: Yahoo 形态周期需要交易所时区")
    zone = ZoneInfo(row["indicator_timezone"])
    moment = datetime.fromtimestamp(row["start"] / 1000, zone)
    session = row.get("indicator_session") or "0000-0000"
    opening, closing = session[:4], session[5:9]
    hour, minute = int(opening[:2]), int(opening[2:])
    high_period = row.get("indicator_timeframe") in ("D1", "W1", "MN")
    overnight = opening > closing
    date = moment.date()
    if overnight and not high_period and (moment.hour, moment.minute) >= (hour, minute):
        date += timedelta(days=1)
    midnight = datetime.combine(date, datetime.min.time(), zone)
    if timeframe in ("D", "W", "M"):
        left = midnight
        if timeframe == "W":
            left -= timedelta(days=left.weekday())
        elif timeframe == "M":
            left = left.replace(day=1)
        right = (left.replace(year=left.year + (left.month == 12), month=left.month % 12 + 1)
                 if timeframe == "M" else left + timedelta(days=7 if timeframe == "W" else 1))
        if overnight and not high_period:
            left = (left - timedelta(days=1)).replace(hour=hour, minute=minute)
            right = (right - timedelta(days=1)).replace(hour=hour, minute=minute)
    else:
        anchor = midnight.replace(hour=hour, minute=minute)
        if moment < anchor:
            anchor -= timedelta(days=1)
        duration = int(timeframe) * 60000
        start = int(anchor.timestamp() * 1000)
        left_ms = start + (row["start"] - start) // duration * duration
        return left_ms, left_ms + duration
    return int(left.timestamp() * 1000), int(right.timestamp() * 1000)


def step(state, row, params):
    """Mutate confirmed state once; preview isolation belongs to the caller."""
    high, low, close = (float(row[key]) for key in ("high", "low", "close"))
    if not all(math.isfinite(v) for v in (high, low, close)):
        raise ValueError(f"{NAME}: 指标输入价格必须是有限数值")
    left, right = bucket(row, params)
    stamp = row.get("chart_time", row["start"])
    previous_bucket = state.get("bucket")
    new_tf = previous_bucket is None or left != previous_bucket["start"]
    if new_tf:
        nr4 = nr7 = False
        if previous_bucket is not None:
            ranges = state.setdefault("ranges", [])
            width = previous_bucket["high"] - previous_bucket["low"]
            ranges.append(width)
            del ranges[:-7]
            nr7 = params["pattern_type"] != "NR4" and width == min(ranges)
            nr4 = params["pattern_type"] != "NR7" and width == min(ranges[-4:]) and not nr7
            if nr4 or nr7:
                state.update(rh=previous_bucket["high"], rl=previous_bucket["low"],
                             up_check=True, down_check=True, line_start=stamp, line_end=stamp)
                state["pattern"] = {"high": state["rh"], "low": state["rl"],
                                    "type": 4 if nr4 else 7,
                                    "start": previous_bucket["chart_start"], "end": stamp}
            else:
                state.pop("pattern", None)
        state.update(nr=nr4 or nr7, up_fired=False, down_fired=False,
                     bucket={"start": left, "end": right, "high": high, "low": low, "chart_start": stamp})
    else:
        previous_bucket["high"] = max(previous_bucket["high"], high)
        previous_bucket["low"] = min(previous_bucket["low"], low)

    rh, rl = state.get("rh"), state.get("rl")
    mid = (rh + rl) / 2 if rh is not None else None
    out = empty()
    out["period_start"] = state["bucket"]["chart_start"]
    if mid is not None:
        # Pine ta.cross* compares both *series* at t-1, including a changed
        # range on the first candle of a new pattern period.
        previous_close, previous_rh, previous_rl = (state.get(k) for k in ("previous_close", "previous_rh", "previous_rl"))
        if close > mid and not state.get("down_check", False):
            state["down_check"] = True
        if (previous_close is not None and previous_rl is not None
                and close < rl and previous_close >= previous_rl and state.get("down_check", False)):
            out["down_signal"] = rh
            state.update(down_check=False, down_fired=True)
        if close < mid and not state.get("up_check", False):
            state["up_check"] = True
        if (previous_close is not None and previous_rh is not None
                and close > rh and previous_close <= previous_rh and state.get("up_check", False)):
            out["up_signal"] = rl
            state.update(up_check=False, up_fired=True)
        # Original line objects survive TF changes. Their right endpoint only
        # advances during NR or after a signal in the current TF, then freezes.
        if state["nr"] or state["up_fired"] or state["down_fired"]:
            state["line_end"] = stamp
        out.update(range_high=rh, range_low=rl, range_mid=mid,
                   range_start=state["line_start"], range_end=state["line_end"])
    pattern = state.get("pattern")
    if pattern:
        out.update({"pattern_" + key: value for key, value in pattern.items()})
    state.update(previous_close=close, previous_rh=rh, previous_rl=rl,
                 last_start=row["start"], last_end=row["end"])
    return out


def calculate(rows, params, *, provisional=False):
    """Full-origin batch counterpart, with ordinary strict gap semantics."""
    state, outputs = {}, {key: [] for key in OUTPUTS}
    for index, row in enumerate(rows):
        preview = provisional and index == len(rows) - 1 and not row["complete"]
        if row.get("gap_before") or not row["complete"] and not preview:
            state = {}
        if row["complete"] or preview:
            trial = copy.deepcopy(state) if preview else state
            values = step(trial, row, params)
        else:
            values = empty()
        for key in OUTPUTS:
            outputs[key].append(values[key])
    return outputs
