"""User supplied Pine v4 Supertrend, semantic contract v1.

The same step is used by batch calculations and durable checkpoints. Missing
intervals/provisional copies are owned by the existing indicator framework.
State contains only finite JSON values; None represents Pine na.
"""

import hashlib
import threading
from collections import OrderedDict

import numpy as np

NAME = "SUPERTREND_PINE_V1"
ALGORITHM = "supertrend-pine-state-v1"
OUTPUTS = ("up", "down", "buy_price", "sell_price", "fill_reference", "direction")
SOURCES = ("open", "high", "low", "close", "hl2", "hlc3", "ohlc4")
METADATA = {
    "label": "超级趋势 Supertrend（Pine 复现）",
    "aliases": ["Supertrend", "SuperTrend", "超级趋势", "Pine", NAME],
    "description": "按用户提供的 Pine v4 规则显示趋势线与 Buy/Sell 翻转。",
    "calculation": "以 Wilder 或 SMA 真实波幅计算递归边界，收盘严格突破上一边界时翻转。",
    "pane": "main",
    "params": {"period": 10, "source": "hl2", "multiplier": 3.0, "atr_method": "wilder"},
    "parameter_schema": {
        "period": {"type": "integer", "min": 1, "max": 500, "default": 10},
        "source": {"type": "enum", "options": list(SOURCES), "default": "hl2"},
        "multiplier": {"type": "float", "min": 0.1, "max": 100, "default": 3.0},
        "atr_method": {"type": "enum", "options": ["wilder", "sma"], "default": "wilder"},
    },
    "input_fields": ["open", "high", "low", "close"],
    "render_profile": "supertrend_pine_v1",
    "display_inputs": {"showsignals": True, "highlighting": True},
    "series": [{"key": key, "type": "line"} for key in OUTPUTS],
    # This is acquisition padding, never a promise of finite recursive warmup.
    # All chart paths evaluate the fixed prefix or restore a verified checkpoint.
    "history_requirement": lambda p: p["period"],
}
_CACHE = OrderedDict()
_CACHE_LOCK = threading.Lock()
_CACHE_VALUES = 250_000


def step(state, open_, high, low, close, params):
    """Advance one complete OHLC bar, preserving the Pine execution order."""
    period = params["period"]
    previous = state.get("previous")
    tr = (high - low if previous is None else
          max(high - low, abs(high - previous), abs(low - previous)))
    atr = state.get("atr")
    if params["atr_method"] == "wilder" and atr is not None:
        atr = (atr * (period - 1) + tr) / period
    else:
        window = state.setdefault("tr_window", [])
        # atr() uses tr(true); bare tr is na without a previous close.
        if previous is not None or params["atr_method"] == "wilder":
            window.append(tr)
        if len(window) > period:
            window.pop(0)
        atr = sum(window) / period if len(window) == period else None
        if atr is not None and params["atr_method"] == "wilder":
            del state["tr_window"]
    reference = (open_ + high + low + close) / 4
    source = {"open": open_, "high": high, "low": low, "close": close,
              "hl2": (high + low) / 2, "hlc3": (high + low + close) / 3,
              "ohlc4": reference}[params["source"]]
    prev_direction = state.get("direction")
    direction = 1 if prev_direction is None else prev_direction
    up = down = None
    if atr is not None:
        up, down = source - params["multiplier"] * atr, source + params["multiplier"] * atr
        up1 = state.get("up")
        down1 = state.get("down")
        up1 = up if up1 is None else up1
        down1 = down if down1 is None else down1
        if previous is not None and previous > up1:
            up = max(up, up1)
        if previous is not None and previous < down1:
            down = min(down, down1)
        if direction == -1 and close > down1:
            direction = 1
        elif direction == 1 and close < up1:
            direction = -1
    state.update(previous=close, atr=atr, up=up, down=down, direction=direction)
    return {
        "up": up if direction == 1 else None,
        "down": down if direction == -1 else None,
        "buy_price": up if direction == 1 and prev_direction == -1 else None,
        "sell_price": down if direction == -1 and prev_direction == 1 else None,
        "fill_reference": reference,
        "direction": direction,
    }


def _calculate(open_, high, low, close, params):
    """Pure equal-length numerical output; inputs are never mutated."""
    state = {}
    outputs = {key: np.full(len(close), np.nan) for key in OUTPUTS}
    for index, prices in enumerate(zip(open_, high, low, close)):
        for key, value in step(state, *map(float, prices), params).items():
            if value is not None:
                outputs[key][index] = value
    return outputs


def calculate(open_, high, low, close, params):
    """Share exact immutable spans across native plot requests.

    Hash actual OHLC bytes, so revisions, origin changes and provisional ticks
    cannot hit an older span. Computation parameters are the only settings in
    this key. Bound cached output by value count, rather than history length.
    """
    weight = len(close) * len(OUTPUTS)
    if weight > _CACHE_VALUES:
        return _calculate(open_, high, low, close, params)
    digest = hashlib.sha256()
    for array in (open_, high, low, close):
        digest.update(np.asarray(array, dtype="<f8").tobytes())
    key = (digest.digest(), len(close), tuple(sorted(params.items())))
    with _CACHE_LOCK:
        if key in _CACHE:
            _CACHE.move_to_end(key)
            return _CACHE[key]
        outputs = _calculate(open_, high, low, close, params)
        for values in outputs.values():
            values.flags.writeable = False
        _CACHE[key] = outputs
        while len(_CACHE) > 32 or sum(len(values["up"]) * len(OUTPUTS)
                                     for values in _CACHE.values()) > _CACHE_VALUES:
            _CACHE.popitem(last=False)
        return outputs
