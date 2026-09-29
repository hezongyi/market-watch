"""Versioned chart indicator catalog; Python is the numerical source of truth."""

import math

import numpy as np
import talib

CATALOG = {
    "SMA": {"label": "SMA 简单均线", "pane": "main", "params": {"period": 20}},
    "EMA": {"label": "EMA 指数均线", "pane": "main", "params": {"period": 20}},
    "LWMA": {"label": "LWMA 线性加权均线", "pane": "main", "params": {"period": 20}},
    "BBANDS": {"label": "布林带", "pane": "main", "params": {"period": 20, "deviation": 2}},
    "RSI": {"label": "RSI", "pane": "sub", "params": {"period": 14}, "levels": [30, 70]},
    "MACD": {"label": "MACD", "pane": "sub", "params": {"fast": 12, "slow": 26, "signal": 9}},
    "ATR": {"label": "ATR", "pane": "sub", "params": {"period": 14}},
    "STOCH": {
        "label": "随机摆动 Stochastic",
        "pane": "sub",
        "params": {"k": 14, "smooth": 3, "d": 3},
        "levels": [20, 80],
    },
}


# New standard indicators register metadata and a pure vectorized calculator here.
# Calculator receives high, low, close arrays and validated parameters, returns keyed arrays.
CALCULATORS = {
    "SMA": lambda h, low, c, p: {"value": talib.SMA(c, timeperiod=p["period"])},
    "EMA": lambda h, low, c, p: {"value": talib.EMA(c, timeperiod=p["period"])},
    "LWMA": lambda h, low, c, p: {"value": talib.WMA(c, timeperiod=p["period"])},
    "BBANDS": lambda h, low, c, p: dict(
        zip(
            ("upper", "middle", "lower"),
            talib.BBANDS(
                c,
                timeperiod=p["period"],
                nbdevup=float(p["deviation"]),
                nbdevdn=float(p["deviation"]),
            ),
        )
    ),
    "RSI": lambda h, low, c, p: {"value": talib.RSI(c, timeperiod=p["period"])},
    "ATR": lambda h, low, c, p: {"value": talib.ATR(h, low, c, timeperiod=p["period"])},
    "MACD": lambda h, low, c, p: dict(
        zip(
            ("macd", "signal", "histogram"),
            talib.MACD(c, fastperiod=p["fast"], slowperiod=p["slow"], signalperiod=p["signal"]),
        )
    ),
    "STOCH": lambda h, low, c, p: dict(
        zip(
            ("k", "d"),
            talib.STOCH(
                h,
                low,
                c,
                fastk_period=p["k"],
                slowk_period=p["smooth"],
                slowk_matype=0,
                slowd_period=p["d"],
                slowd_matype=0,
            ),
        )
    ),
}


def register(name, metadata, calculator):
    """Register a Python indicator before app startup; no browser code execution."""
    if name in CATALOG:
        raise ValueError("Indicator already registered; version changes require a new id")
    CATALOG[name] = metadata
    CALCULATORS[name] = calculator


def validate(spec):
    if not isinstance(spec, dict):
        raise ValueError("无效指标配置")
    name = spec.get("name")
    if name not in CATALOG or spec.get("version", "1") != "1":
        raise ValueError("未知指标或版本")
    defaults = CATALOG[name]["params"]
    supplied = spec.get("params", {})
    if not isinstance(supplied, dict) or set(supplied) - set(defaults):
        raise ValueError("未知指标参数")
    params = defaults | supplied
    for k, v in params.items():
        if k == "deviation":
            if isinstance(v, bool) or not isinstance(v, (int, float)) or not 0.1 <= v <= 10:
                raise ValueError("标准差倍数应为0.1至10")
        elif type(v) is not int or not 2 <= v <= 500:
            raise ValueError("指标周期应为2至500的整数")
    if name == "MACD" and params["fast"] >= params["slow"]:
        raise ValueError("MACD快线周期必须小于慢线")
    return name, params


def calculate(rows, spec):
    name, p = validate(spec)
    arrays = {
        key: np.array([float(r[key]) if r["complete"] else np.nan for r in rows])
        for key in ("high", "low", "close")
    }
    # Restart after an incomplete bar: do not bridge an unknown interval with invented prices.
    outputs = {}
    # A missing interval breaks recursive state, even when its next bar is complete.
    mask = np.isfinite(arrays["close"])
    edges = list(np.flatnonzero(np.diff(np.r_[False, mask, False])))
    spans = []
    for start, end in zip(edges[::2], edges[1::2]):
        cuts = [start] + [i for i in range(start + 1, end) if rows[i].get("gap_before")] + [end]
        spans.extend(zip(cuts, cuts[1:]))
    # Empty input still returns the declared output shape.
    empty = np.array([], dtype=float)
    keys = list(CALCULATORS[name](empty, empty, empty, p))
    for key in keys:
        outputs[key] = np.full(len(rows), np.nan)
    for start, end in spans:
        h, low, c = (arrays[k][start:end] for k in ("high", "low", "close"))
        for key, values in CALCULATORS[name](h, low, c, p).items():
            if len(values) != end - start:
                raise ValueError("指标输出长度与输入不一致")
            outputs[key][start:end] = values
    return {
        "name": name,
        "version": "1",
        "params": p,
        "pane": CATALOG[name]["pane"],
        "levels": CATALOG[name].get("levels", []),
        "series": [
            {
                "key": key,
                "type": CATALOG[name]
                .get("styles", {})
                .get(key, "histogram" if key == "histogram" else "line"),
                "values": [
                    {"time": row["start"], "value": float(v) if math.isfinite(v) else None}
                    for row, v in zip(rows, values)
                ],
            }
            for key, values in outputs.items()
        ],
    }
