"""Versioned chart indicator catalog; Python is the numerical source of truth."""

import math
from copy import deepcopy

import numpy as np
import talib

CATALOG = {
    "SMA": {"label": "SMA 简单均线", "pane": "main", "params": {"period": 20}},
    "EMA": {"label": "EMA 指数均线", "pane": "main", "params": {"period": 20}},
    "LWMA": {"label": "LWMA 线性加权均线", "pane": "main", "params": {"period": 20}},
    "BBANDS": {"label": "布林带", "pane": "main", "params": {"period": 20, "deviation": 2}},
    "RSI": {"label": "相对强弱指数", "pane": "sub", "params": {"period": 14}, "levels": [30, 70]},
    "MACD": {
        "label": "指数平滑异同均线",
        "pane": "sub",
        "params": {"fast": 12, "slow": 26, "signal": 9},
    },
    "ATR": {"label": "平均真实波幅", "pane": "sub", "params": {"period": 14}},
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


# Output and input order are persisted native-study contracts. Keep them stable.
_OUTPUTS = {
    "BBANDS": ("upper", "middle", "lower"),
    "MACD": ("macd", "signal", "histogram"),
    "STOCH": ("k", "d"),
}
_ALIASES = {
    "SMA": ["均线", "Moving Average", "Simple Moving Average"],
    "EMA": ["均线", "Exponential Moving Average"],
    "LWMA": ["均线", "WMA", "Weighted Moving Average"],
    "BBANDS": ["BB", "Bollinger Bands"],
    "RSI": ["Relative Strength Index"],
    "MACD": ["Moving Average Convergence Divergence"],
    "ATR": ["Average True Range"],
    "STOCH": ["Stochastic", "随机指标"],
}
_DETAILS = {
    "SMA": ("平滑价格，观察趋势。", "取最近 period 根收盘价的算术平均值。"),
    "EMA": ("观察更重视近期价格的趋势。", "对收盘价递归加权，近期价格权重更高。"),
    "LWMA": ("观察更重视近期价格的趋势。", "对最近 period 根收盘价线性加权，越近权重越高。"),
    "BBANDS": (
        "观察价格相对均线的位置与波动范围。",
        "中轨为简单均线，上下轨为中轨加减 deviation 倍标准差。",
    ),
    "RSI": (
        "比较近期上涨与下跌幅度，观察价格动量。",
        "按 period 平滑平均涨跌幅，换算为 0 至 100 的相对强弱值。",
    ),
    "MACD": (
        "观察快慢趋势差异及动量变化。",
        "快线 EMA 减慢线 EMA 得到 MACD，signal 为其 EMA，柱线为两者之差。",
    ),
    "ATR": (
        "衡量波动幅度，不表示涨跌方向。",
        "真实波幅取当根高低差及相对前收盘价差的最大值，再按 period 平滑。",
    ),
    "STOCH": (
        "观察收盘价在近期高低区间的位置。",
        "以 k 根高低区间计算位置比例，依次用 smooth 和 d 简单均线得到 K、D。",
    ),
}
_PARAMETER_LABELS = {"period":"计算周期", "fast":"快线周期", "slow":"慢线周期",
    "signal":"信号周期", "deviation":"标准差倍数", "k":"K 线周期", "smooth":"K 线平滑周期", "d":"D 线周期"}
_OUTPUT_LABELS = {"value":"指标值", "macd":"MACD 线", "signal":"信号线", "histogram":"柱状差值",
    "upper":"上轨", "middle":"中轨", "lower":"下轨", "k":"K 线", "d":"D 线"}
for _name, _meta in CATALOG.items():
    _meta["description"], _meta["calculation"] = _DETAILS[_name]
    _meta["series"] = [
        {"key": key, "label": _OUTPUT_LABELS[key], "type": "histogram" if key == "histogram" else "line"}
        for key in _OUTPUTS.get(_name, ("value",))
    ]
    _meta["aliases"] = [_name, *_ALIASES[_name]]
    _meta["parameter_schema"] = {
        key: {"type": "float", "min": 0.1, "max": 10, "default": value}
        if key == "deviation"
        else {"type": "integer", "min": 2, "max": 500, "default": value}
        for key, value in _meta["params"].items()
    }
    for _key, _schema in _meta["parameter_schema"].items():
        _schema["label"] = _PARAMETER_LABELS[_key]


def _validate_metadata(name, meta):
    if not isinstance(name, str) or not name or len(name) > 80:
        raise ValueError("Invalid indicator ID")
    if not isinstance(meta, dict):
        raise ValueError(f"{name}: metadata must be a dictionary")
    if not isinstance(meta.get("label"), str) or not meta["label"]:
        raise ValueError(f"{name}: label must be a nonempty string")
    for field in ("description", "calculation"):
        if field in meta and not isinstance(meta[field], str):
            raise ValueError(f"{name}: {field} must be a string")
    if not isinstance(meta.get("aliases", []), list) or any(
        not isinstance(alias, str) for alias in meta.get("aliases", [])
    ):
        raise ValueError(f"{name}: aliases must be strings")
    if not isinstance(meta.get("levels", []), list) or any(
        type(value) not in (int, float) or not math.isfinite(value)
        for value in meta.get("levels", [])
    ):
        raise ValueError(f"{name}: levels must be finite numbers")
    if meta.get("pane") not in ("main", "sub"):
        raise ValueError(f"{name}: pane must be main or sub")
    params, series = meta.get("params"), meta.get("series")
    if not isinstance(params, dict) or not isinstance(series, list) or not series:
        raise ValueError(f"{name}: params and explicit series declarations required")
    keys = []
    for item in series:
        if (
            not isinstance(item, dict)
            or not isinstance(item.get("key"), str)
            or not item["key"]
            or item.get("type") not in ("line", "histogram")
        ):
            raise ValueError(f"{name}: invalid output declaration")
        if "label" in item and (not isinstance(item["label"], str) or not item["label"]):
            raise ValueError(f"{name}: invalid output label")
        keys.append(item["key"])
    if len(set(keys)) != len(keys):
        raise ValueError(f"{name}: duplicate output keys")
    schema = meta.get("parameter_schema", {})
    if not isinstance(schema, dict) or set(schema) != set(params):
        raise ValueError(f"{name}: parameter schema must match params")
    for key, rule in schema.items():
        if (
            not isinstance(rule, dict)
            or rule.get("type") not in ("integer", "float")
            or not all(
                type(rule.get(k)) in (int, float) and math.isfinite(rule[k])
                for k in ("min", "max", "default")
            )
            or rule["min"] > rule["max"]
            or rule["default"] != params[key]
        ):
            raise ValueError(f"{name}: invalid parameter declaration {key}")
        if "label" in rule and (not isinstance(rule["label"], str) or not rule["label"]):
            raise ValueError(f"{name}: invalid parameter label")
        _validate_parameter(name, key, params[key], rule)
    if "history_requirement" in meta and not callable(meta["history_requirement"]):
        raise ValueError(f"{name}: history_requirement must be callable")


def _validate_parameter(name, key, value, rule):
    integer = rule["type"] == "integer"
    if (
        type(value) not in ((int,) if integer else (int, float))
        or not math.isfinite(value)
        or not rule["min"] <= value <= rule["max"]
    ):
        raise ValueError(
            f"{name}: {key} 应为{rule['min']}至{rule['max']}的" + ("整数" if integer else "数值")
        )


def register(name, metadata, calculator):
    """Register declarations and a pure calculator, without executing the algorithm."""
    meta = deepcopy(metadata)
    _validate_metadata(name, meta)
    if name in CATALOG:
        raise ValueError(f"{name}: already registered; semantic changes require a new id")
    if not callable(calculator):
        raise ValueError(f"{name}: calculator must be callable")
    CATALOG[name] = meta
    CALCULATORS[name] = calculator


for _name, _meta in CATALOG.items():
    _validate_metadata(_name, _meta)


def public_catalog():
    """Only serializable display/contract fields; never invoke calculators."""
    fields = ("label", "aliases", "pane", "params", "levels", "description", "calculation")
    return {
        name: {
            **deepcopy({key: meta[key] for key in fields if key in meta}),
            "series": [{key: item[key] for key in ("key", "type", "label") if key in item} for item in meta["series"]],
            "parameter_schema": {
                parameter: {key: rule[key] for key in ("type", "min", "max", "default", "label") if key in rule}
                for parameter, rule in meta["parameter_schema"].items()
            },
            "version": "1",
            "source": "Python",
        }
        for name, meta in CATALOG.items()
    }


def validate(spec):
    if not isinstance(spec, dict):
        raise ValueError("无效指标配置")
    name = spec.get("name")
    if not isinstance(name, str) or name not in CATALOG or spec.get("version", "1") != "1":
        raise ValueError("未知指标或版本")
    defaults = CATALOG[name]["params"]
    supplied = spec.get("params", {})
    if not isinstance(supplied, dict) or set(supplied) - set(defaults):
        raise ValueError("未知指标参数")
    params = defaults | supplied
    for key, value in params.items():
        _validate_parameter(name, key, value, CATALOG[name]["parameter_schema"][key])
    if name == "MACD" and params["fast"] >= params["slow"]:
        raise ValueError("MACD快线周期必须小于慢线")
    return name, params


def history_requirement(spec):
    """Extra complete bars before a page; recursive warmup is an approximation."""
    name, params = validate(spec)
    requirement = CATALOG[name].get("history_requirement")
    if requirement is not None:
        try:
            result = requirement(dict(params))
        except Exception as exc:
            raise ValueError(f"{name}: history requirement failed: {exc}") from exc
        if type(result) is not int or result < 0:
            raise ValueError(f"{name}: history requirement must be a nonnegative integer")
        return result
    if name == "MACD":
        return 10 * (params["slow"] + params["signal"])
    if name == "STOCH":
        return params["k"] + params["smooth"] + params["d"] - 3
    if name in ("EMA", "RSI", "ATR"):
        return 10 * params["period"]
    if "period" in params:
        return params["period"] - 1
    raise ValueError(f"{name}: 该指标尚未声明前置历史要求")


def _run(name, h, low, c, params):
    # Protect the caller's data and prevent accidental in-place algorithm mutation.
    inputs = [array.copy() for array in (h, low, c)]
    for array in inputs:
        array.flags.writeable = False
    try:
        values = CALCULATORS[name](*inputs, dict(params))
    except Exception as exc:
        raise ValueError(f"{name}: calculator failed: {exc}") from exc
    expected = [item["key"] for item in CATALOG[name]["series"]]
    if not isinstance(values, dict) or list(values) != expected:
        raise ValueError(f"{name}: output keys/order must be {expected}")
    for key, output in values.items():
        try:
            array = np.asarray(output)
        except (ValueError, TypeError) as exc:
            raise ValueError(f"{name}: invalid numeric output {key}: {exc}") from exc
        if array.ndim != 1 or len(array) != len(c) or array.dtype.kind not in "iuf":
            raise ValueError(
                f"{name}: {key} must be a one-dimensional numeric array of length {len(c)}"
            )
    return values


def calculate(rows, spec, *, provisional=False):
    # The live last candle is recomputed from the confirmed prefix. Never
    # mutate the caller's rows or advance a recursive accumulator on a tick.
    provisional_time = rows[-1]["start"] if provisional and rows and not rows[-1]["complete"] else None
    if provisional_time is not None:
        rows = [*rows[:-1], {**rows[-1], "complete": True}]
    name, p = validate(spec)
    arrays = {
        key: np.array([float(r[key]) if r["complete"] else np.nan for r in rows])
        for key in ("high", "low", "close")
    }
    # Restart after an incomplete bar: do not bridge an unknown interval with invented prices.
    outputs = {item["key"]: np.full(len(rows), np.nan) for item in CATALOG[name]["series"]}
    # A missing interval breaks recursive state, even when its next bar is complete.
    mask = np.isfinite(arrays["close"])
    edges = list(np.flatnonzero(np.diff(np.r_[False, mask, False])))
    spans = []
    for start, end in zip(edges[::2], edges[1::2]):
        cuts = [start] + [i for i in range(start + 1, end) if rows[i].get("gap_before")] + [end]
        spans.extend(zip(cuts, cuts[1:]))
    for start, end in spans:
        h, low, c = (arrays[k][start:end] for k in ("high", "low", "close"))
        for key, values in _run(name, h, low, c, p).items():
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
                "type": next(
                    item["type"] for item in CATALOG[name]["series"] if item["key"] == key
                ),
                "values": [
                    {"time": row["start"], "value": float(v) if math.isfinite(v) else None,
                     **({"provisional": True} if row["start"] == provisional_time else {})}
                    for row, v in zip(rows, values)
                ],
            }
            for key, values in outputs.items()
        ],
    }
