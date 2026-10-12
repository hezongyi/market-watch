"""Swing V1: strict symmetric pivots and cumulative within-segment spacing.

The same bounded state drives vector calculations and fixed-history checkpoints.
There is no persisted preview: callers clone a confirmed checkpoint for a tick.
"""

from copy import deepcopy
from math import isfinite

import numpy as np

NAME = "SWING_SR_V1"
PROFILE = "swing_sr_v1"
KEYS = ("high", "high_left", "low", "low_left")


def empty_statistics():
    return {
        side: {
            "event_count": 0,
            "confirmed_count": 0,
            "preview_count": 0,
            "interval_sum": 0,
            "interval_count": 0,
        }
        for side in ("high", "low")
    }


def statistics(values):
    result = deepcopy(values)
    for item in result.values():
        total, count = item["interval_sum"], item["interval_count"]
        item["mean"] = total / count if count else None
        # Exact positive ROUND_HALF_UP, without binary-float rounding ties.
        item["display_integer"] = (2 * total + count) // (2 * count) if count else None
    return result


class SwingState:
    def __init__(self, params, state=None):
        self.params = dict(params)
        self.state = (
            deepcopy(state)
            if state
            else {
                "n": 0,
                "window": [],
                "current": {"high": None, "low": None},
                "previous": {"high": None, "low": None},
                "statistics": empty_statistics(),
                "origin": None,
                "as_of": None,
                "seam": False,
                "last_end": None,
            }
        )

    def step(self, row, *, provisional=False):
        s = self.state
        if s["origin"] is None:
            s["origin"] = row["start"]
        s["as_of"] = row["start"]
        if "chart_time" in row:
            s["as_of_chart_time"] = row["chart_time"]
        else:
            s.pop("as_of_chart_time", None)
        s["n"] += 1
        index = s["n"] - 1
        if row.get("gap_before") or not row["complete"] and not provisional:
            s["window"] = []
            s["current"] = {"high": None, "low": None}
            s["previous"] = {"high": None, "low": None}
        s["last_end"] = row.get("end")
        if not row["complete"] and not provisional:
            return dict.fromkeys(KEYS), []
        if not all(isfinite(float(row[side])) for side in ("high", "low")):
            raise ValueError("Swing input prices must be finite")
        s["seam"] |= bool(row.get("seam_crossing") or row.get("seam_at_start"))
        s["window"].append(
            {
                "index": index,
                "start": row["start"],
                "high": float(row["high"]),
                "low": float(row["low"]),
                **({"chart_time": row["chart_time"]} if "chart_time" in row else {}),
            }
        )
        del s["window"][: -2 * max(self.params.values()) - 1]
        events = []
        for side in ("high", "low"):
            strength = self.params[side + "_strength"]
            window = s["window"][-2 * strength - 1 :]
            if len(window) != 2 * strength + 1:
                continue
            pivot = window[strength]
            price = pivot[side]
            neighbors = window[:strength] + window[strength + 1 :]
            strict = all(
                price > other[side] if side == "high" else price < other[side]
                for other in neighbors
            )
            if not strict:
                continue
            event = {
                "side": side,
                "price": price,
                "pivot_time": pivot["start"],
                "detected_bar_time": row["start"],
                "confirmed_at": None if provisional else row.get("end"),
                "provisional": provisional,
                "pivot_index": pivot["index"],
                **({"pivot_chart_time": pivot["chart_time"]} if "chart_time" in pivot else {}),
            }
            prior = s["previous"][side]
            item = s["statistics"][side]
            if prior is not None:
                item["interval_sum"] += pivot["index"] - prior
                item["interval_count"] += 1
            item["event_count"] += 1
            item["preview_count" if provisional else "confirmed_count"] += 1
            s["previous"][side] = pivot["index"]
            s["current"][side] = event
            events.append(event)
        return {
            key: s["current"][key.split("_")[0]]["price"]
            if s["current"][key.split("_")[0]]
            else None
            for key in KEYS
        }, events

    def presentation(self):
        return {
            "render_profile": PROFILE,
            "as_of_bar_time": self.state["as_of"],
            **(
                {"as_of_chart_time": self.state["as_of_chart_time"]}
                if "as_of_chart_time" in self.state
                else {}
            ),
            "statistics_origin": self.state["origin"],
            "current": {
                side: {
                    key: value for key, value in event.items() if key not in ("side", "pivot_index")
                }
                if event
                else None
                for side, event in self.state["current"].items()
            },
            "statistics": statistics(self.state["statistics"]),
        }


def calculate_vectors(high, low, close, params):
    """Explicit series/presentation result; local times are mapped by the framework."""
    engine = SwingState(params)
    outputs = {key: np.full(len(close), np.nan) for key in KEYS}
    events = []
    for index in range(len(close)):
        values, detected = engine.step(
            {
                "start": index,
                "end": index + 1,
                "high": high[index],
                "low": low[index],
                "complete": True,
            }
        )
        for key, value in values.items():
            if value is not None:
                outputs[key][index] = value
        events.extend(detected)
    return {"series": outputs, "presentation": {"events": events}}


METADATA = {
    "label": "Swing 高低点支撑阻力",
    "aliases": ["Swing", "支撑阻力", "SWING_SR_V1"],
    "pane": "main",
    "params": {"high_strength": 5, "low_strength": 5},
    "parameter_schema": {
        side + "_strength": {"type": "integer", "min": 1, "max": 500, "default": 5}
        for side in ("high", "low")
    },
    "series": [{"key": key, "type": "line"} for key in KEYS],
    "description": "严格对称窗口识别高低点，显示可撤回的盘中预览。",
    "calculation": "高低独立；同类相邻极值的柱数间隔累计平均，缺口两侧不配对。",
    "history_requirement": lambda p: 2 * max(p.values()),
    "result_format": "series_presentation_v1",
    "render_profile": PROFILE,
    "display_inputs": [
        {
            "id": "hh_source",
            "name": "HH source",
            "type": "text",
            "default": "high",
            "options": ["high"],
        },
        {
            "id": "ll_source",
            "name": "LL source",
            "type": "text",
            "default": "low",
            "options": ["low"],
        },
        {"id": "show_average_spacing", "name": "显示平均间隔", "type": "bool", "default": True},
        {
            "id": "statistics_position",
            "name": "统计位置",
            "type": "text",
            "default": "bottom_left",
            "options": ["below_name", "bottom_left"],
        },
    ],
}


def register_indicator():
    from .chart_indicators import CATALOG, register

    if NAME not in CATALOG:
        register(NAME, METADATA, calculate_vectors)
