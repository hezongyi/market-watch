"""Pine v6 Rolling Range Squeeze, including confirmed queue and drawing order.

The queue is read before the current bar is appended. A realtime execution is
made on a copy of the previous close's state, matching Pine's rollback model.
Times on retained drawings travel with the bar; they are never extrapolated
from elapsed minutes (weekends and observed FX gaps are ordinary bar indexes).
"""

from copy import deepcopy
from decimal import ROUND_HALF_UP, Decimal
from math import ceil, isfinite

import numpy as np

NAME = "ROLLING_RANGE_SQUEEZE"
PROFILE = "rolling_range_squeeze_v1"
ALGORITHM = "rolling-range-squeeze-pine-v6-v1"
KEYS = ("sma", "ratio", "threshold", "pct_rank", "signal")


class SqueezeState:
    def __init__(self, params, state=None, *, copy_state=True):
        self.params = dict(params)
        self.state = (deepcopy(state) if copy_state else state) if state else {
            "n": 0, "origin": None, "as_of": None, "last_end": None,
            "seam": False, "window": [], "ratios": [], "prev_signal": False,
            "segment": None, "boxes": [], "labels": [],
        }

    def step(self, row, *, provisional=False):
        s, p = self.state, self.params
        if s["origin"] is None:
            s["origin"] = row["start"]
        s["n"] += 1
        s["as_of"], s["last_end"] = row["start"], row.get("end")
        # Explicit missing/corrupt input restarts calculations, retaining history
        # drawings. Ordinary absent minutes are admitted by observed input policy.
        if row.get("gap_before") or not row["complete"] and not provisional:
            s.update(window=[], ratios=[], prev_signal=False, segment=None)
        if not row["complete"] and not provisional:
            return dict.fromkeys(KEYS)
        high, low, close = (float(row[key]) for key in ("high", "low", "close"))
        if not all(isfinite(value) for value in (high, low, close)):
            raise ValueError("Rolling Range Squeeze input prices must be finite")
        s["seam"] |= bool(row.get("seam_crossing") or row.get("seam_at_start"))
        s["window"].append({"time": row["start"],
                            "chart_time": row.get("chart_time", row["start"]),
                            "high": high, "low": low, "close": close})
        del s["window"][:-p["k"]]
        window = s["window"]
        top, bottom = max(r["high"] for r in window), min(r["low"] for r in window)
        sma = sum(r["close"] for r in window) / p["k"] if len(window) == p["k"] else None
        ratio = (top - bottom) / sma if sma is not None and sma != 0 else None
        history = s["ratios"]
        enough = len(history) >= p["lookback"]
        threshold = sorted(history)[ceil(p["low_pct"] * len(history) / 100) - 1] if enough else None
        rank = sum(value <= ratio for value in history) * 100.0 / len(history) if enough and ratio is not None else None
        signal = bool(enough and ratio is not None and ratio <= threshold
                      and (not p["confirm_on_close"] or not provisional))
        if signal:
            if not s["prev_signal"]:
                segment = {"id": s["n"] - 1, "left": window[0]["time"],
                           "left_chart_time": window[0]["chart_time"],
                           "first": row["start"], "first_chart_time": row.get("chart_time", row["start"]),
                           "top": top, "bottom": bottom}
                s["segment"] = segment
                s["labels"].append({"time": row["start"],
                                    "chart_time": row.get("chart_time", row["start"]),
                                    "price": top, "pct_rank": rank,
                                    "text": "PctRank: " + str(Decimal(str(rank)).quantize(
                                        Decimal("0.01"), rounding=ROUND_HALF_UP)).rstrip("0").rstrip(".") + "%"})
                del s["labels"][:-500]
            segment = s["segment"]
            if s["prev_signal"]:
                extension = next((box for box in s["boxes"]
                                  if box["id"] == f"{segment['id']}:extension"), None)
                if extension is None:
                    extension = {**segment, "id": f"{segment['id']}:extension", "kind": "extension"}
                    s["boxes"].append(extension)
                extension.update(right=row["start"], right_chart_time=row.get("chart_time", row["start"]))
                # Pine deletes/recreates the green box after updating orange.
                s["boxes"] = [box for box in s["boxes"] if box["id"] != f"{segment['id']}:first"]
            s["boxes"].append({**segment, "id": f"{segment['id']}:first", "kind": "first",
                               "right": segment["first"], "right_chart_time": segment["first_chart_time"]})
            del s["boxes"][:-500]
        elif s["prev_signal"]:
            s["segment"] = None
        s["prev_signal"] = signal
        if not provisional and ratio is not None:
            history.append(ratio)
            del history[:-p["lookback"]]
        return dict(zip(KEYS, (sma, ratio, threshold, rank, int(signal))))

    def presentation(self):
        return {"render_profile": PROFILE, "as_of_bar_time": self.state["as_of"],
                "calculation_origin": self.state["origin"],
                "boxes": deepcopy(self.state["boxes"]), "labels": deepcopy(self.state["labels"]),
                "alert": {"title": "Rolling Range Squeeze", "message": "Rolling Range Squeeze triggered",
                          "active": self.state["prev_signal"]}}


def calculate_rows(rows, params, *, provisional=False):
    engine = SqueezeState(params)
    outputs = {key: [] for key in KEYS}
    for i, row in enumerate(rows):
        preview = provisional and i == len(rows) - 1 and not row["complete"]
        values = engine.step(row, provisional=preview)
        for key, value in values.items():
            outputs[key].append({"time": row["start"], "value": value,
                                 **({"break_before": True} if row.get("gap_before") else {}),
                                 **({"provisional": True} if preview else {})})
    return {"name": NAME, "version": "1", "params": params, "pane": "main", "levels": [],
            "series": [{"key": key, "type": "line", "values": values} for key, values in outputs.items()],
            "presentation": engine.presentation()}


def calculate_vectors(high, low, close, params):
    result = calculate_rows([{"start": i, "end": i + 1, "high": high[i], "low": low[i],
                              "close": close[i], "complete": True} for i in range(len(close))], params)
    return {s["key"]: np.array([np.nan if v["value"] is None else v["value"] for v in s["values"]])
            for s in result["series"]}


METADATA = {
    "label": "Rolling Range Squeeze 滚动区间收缩",
    "aliases": ["Rolling Range Squeeze", "RRS", "滚动区间收缩", "挤压"],
    "pane": "main", "render_profile": PROFILE,
    "params": {"k": 10, "lookback": 252, "low_pct": 5.0, "confirm_on_close": True},
    "parameter_schema": {
        "k": {"type": "integer", "min": 1, "max": 100000, "default": 10, "label": "K"},
        "lookback": {"type": "integer", "min": 20, "max": 100000, "default": 252, "label": "Percentile Lookback"},
        "low_pct": {"type": "float", "min": 0.1, "max": 50.0, "step": 0.1, "default": 5.0, "label": "Lowest Percentile (%)"},
        "confirm_on_close": {"type": "bool", "default": True, "label": "Only confirm on bar close"},
    },
    "series": [{"key": key, "type": "line", "label": "SMA(Close, K)" if key == "sma" else key} for key in KEYS],
    "description": "原版 Pine v6 Rolling Range Squeeze：均线、首框、连续扩展框与 PctRank。",
    "calculation": "当前 K 根高低差 / 收盘 SMA；阈值来自此前 lookback 个已收盘有效比值的 nearest-rank 分位数。",
    "history_requirement": lambda p: p["k"] + p["lookback"] - 1,
    "display_inputs": [{"id": key, "name": label, "type": "color", "default": color} for key, label, color in (
        ("first_border_color", "First Signal Box Border", "#4caf50"),
        ("first_fill_color", "First Signal Box Fill", "rgba(76,175,80,0.18)"),
        ("next_border_color", "Extension Box Border", "#ff9800"),
        ("next_fill_color", "Extension Box Fill", "rgba(255,152,0,0.18)"),
        ("sma_color", "SMA Color", "#2196f3"),
        ("label_bg_color", "Label Background", "rgba(76,175,80,0.45)"),
        ("label_text_color", "Label Text Color", "#ffffff"),
    )],
}
