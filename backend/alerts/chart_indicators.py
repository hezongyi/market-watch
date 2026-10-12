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


# Calculators receive readonly arrays in declared input_fields order, followed
# by validated parameters. Existing declarations default to high, low, close.
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
    fields = meta.get("input_fields", ["high", "low", "close"])
    if (not isinstance(fields, list) or not fields
            or any(not isinstance(field, str) or field not in ("open", "high", "low", "close")
                   for field in fields) or len(set(fields)) != len(fields)):
        raise ValueError(f"{name}: invalid input_fields")
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
        if isinstance(rule, dict) and rule.get("type") == "enum":
            options = rule.get("options")
            if (not isinstance(options, list) or not options
                    or any(not isinstance(value, str) or not value for value in options)
                    or len(set(options)) != len(options) or rule.get("default") != params[key]):
                raise ValueError(f"{name}: invalid parameter declaration {key}")
            _validate_parameter(name, key, params[key], rule)
            continue
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
    if meta.get("result_format") not in (None, "series_presentation_v1"):
        raise ValueError(f"{name}: unknown result format")
    profile = meta.get("render_profile")
    if profile not in (None, "swing_sr_v1", "supertrend_pine_v1"):
        raise ValueError(f"{name}: invalid render_profile")
    if (profile == "swing_sr_v1") != bool(meta.get("result_format")):
        raise ValueError(f"{name}: Swing render profile requires the extended result contract")
    display = meta.get("display_inputs", [])
    if profile == "supertrend_pine_v1":
        if (not isinstance(display, dict) or set(display) - {"showsignals", "highlighting"}
                or any(type(value) is not bool for value in display.values())):
            raise ValueError(f"{name}: invalid display_inputs")
        return
    if not isinstance(display, list):
        raise ValueError(f"{name}: invalid display inputs")
    seen = set(params)
    for item in display:
        if (not isinstance(item, dict) or not isinstance(item.get("id"), str)
                or item["id"] in seen or not isinstance(item.get("name"), str)
                or item.get("type") not in ("bool", "text")):
            raise ValueError(f"{name}: invalid display input")
        seen.add(item["id"])
        if item["type"] == "bool":
            valid = type(item.get("default")) is bool
        else:
            options = item.get("options")
            valid = (isinstance(options, list) and bool(options)
                     and all(isinstance(option, str) for option in options)
                     and item.get("default") in options)
        if not valid:
            raise ValueError(f"{name}: invalid display default/options")


def _validate_parameter(name, key, value, rule):
    if rule["type"] == "enum":
        if not isinstance(value, str) or value not in rule["options"]:
            raise ValueError(f"{name}: {key} 应为 {' / '.join(rule['options'])}")
        return
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
    fields = ("label", "aliases", "pane", "params", "levels", "description", "calculation",
              "render_profile", "display_inputs")
    return {
        name: {
            **deepcopy({key: meta[key] for key in fields if key in meta}),
            "series": [{key: item[key] for key in ("key", "type", "label") if key in item} for item in meta["series"]],
            "parameter_schema": {
                parameter: {key: deepcopy(rule[key]) for key in
                            ("type", "min", "max", "default", "options", "label") if key in rule}
                for parameter, rule in meta["parameter_schema"].items()
            },
            "version": "1",
            "source": "Python",
            **({"display_inputs": [{key: deepcopy(item[key]) for key in
                                    ("id", "name", "type", "default", "options") if key in item}
                                   for item in meta["display_inputs"]]}
               if isinstance(meta.get("display_inputs"), list) else {}),
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
    if "display_inputs" in spec:
        validate_display(name, spec["display_inputs"])
    return name, params


def validate_display(name, supplied):
    """Display settings never enter numerical specs or cache identities."""
    declarations = CATALOG[name].get("display_inputs", [])
    rules = ({key: {"type": "bool", "default": value} for key, value in declarations.items()}
             if isinstance(declarations, dict) else {item["id"]: item for item in declarations})
    if not isinstance(supplied, dict) or set(supplied) - set(rules):
        raise ValueError(f"{name}: unknown display inputs")
    result = {key: item["default"] for key, item in rules.items()} | supplied
    for key, value in result.items():
        rule = rules[key]
        if (rule["type"] == "bool" and type(value) is not bool
                or rule["type"] == "text" and value not in rule["options"]):
            raise ValueError(f"{name}: invalid display input {key}")
    return result


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


def _run(name, arrays, params):
    # Protect the caller's data and prevent accidental in-place algorithm mutation.
    inputs = [array.copy() for array in arrays.values()]
    for array in inputs:
        array.flags.writeable = False
    try:
        values = CALCULATORS[name](*inputs, dict(params))
    except Exception as exc:
        raise ValueError(f"{name}: calculator failed: {exc}") from exc
    expected = [item["key"] for item in CATALOG[name]["series"]]
    presentation = None
    if CATALOG[name].get("result_format") == "series_presentation_v1":
        if not isinstance(values, dict) or set(values) != {"series", "presentation"}:
            raise ValueError(f"{name}: invalid extended result")
        presentation, values = values["presentation"], values["series"]
        # V1 accepts local event records only, never arbitrary calculator objects.
        fields = {"side", "price", "pivot_time", "detected_bar_time", "confirmed_at",
                  "provisional", "pivot_index"}
        if (not isinstance(presentation, dict) or set(presentation) != {"events"}
                or not isinstance(presentation["events"], list)):
            raise ValueError(f"{name}: invalid presentation")
        for event in presentation["events"]:
            if (not isinstance(event, dict) or set(event) != fields
                    or event["side"] not in ("high", "low")
                    or type(event["price"]) not in (int, float) or not math.isfinite(event["price"])
                    or any(type(event[key]) is not int for key in
                           ("pivot_time", "detected_bar_time", "pivot_index", "confirmed_at"))
                    or not 0 <= event["pivot_time"] < event["detected_bar_time"] < len(inputs[0])
                    or event["pivot_index"] != event["pivot_time"]
                    or event["confirmed_at"] != event["detected_bar_time"] + 1
                    or event["provisional"] is not False):
                raise ValueError(f"{name}: invalid presentation event")
            if event["detected_bar_time"] - event["pivot_time"] != params[event["side"] + "_strength"]:
                raise ValueError(f"{name}: invalid event detection window")
    if not isinstance(values, dict) or list(values) != expected:
        raise ValueError(f"{name}: output keys/order must be {expected}")
    for key, output in values.items():
        try:
            array = np.asarray(output)
        except (ValueError, TypeError) as exc:
            raise ValueError(f"{name}: invalid numeric output {key}: {exc}") from exc
        length = len(inputs[0])
        if array.ndim != 1 or len(array) != length or array.dtype.kind not in "iuf":
            raise ValueError(
                f"{name}: {key} must be a one-dimensional numeric array of length {length}"
            )
    return values, presentation


def calculate(rows, spec, *, provisional=False):
    # The live last candle is recomputed from the confirmed prefix. Never
    # mutate the caller's rows or advance a recursive accumulator on a tick.
    provisional_time = rows[-1]["start"] if provisional and rows and not rows[-1]["complete"] else None
    if provisional_time is not None:
        rows = [*rows[:-1], {**rows[-1], "complete": True}]
    name, p = validate(spec)
    try:
        arrays = {
            key: np.array([float(r[key]) if r["complete"] else np.nan for r in rows])
            for key in CATALOG[name].get("input_fields", ["high", "low", "close"])
        }
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError(f"{name}: missing or invalid OHLC input: {exc}") from exc
    for array in arrays.values():
        if any(row["complete"] and not math.isfinite(value) for row, value in zip(rows, array)):
            raise ValueError(f"{name}: 指标输入价格必须是有限数值")
    # Restart after an incomplete bar: do not bridge an unknown interval with invented prices.
    outputs = {item["key"]: np.full(len(rows), np.nan) for item in CATALOG[name]["series"]}
    extended = CATALOG[name].get("result_format") == "series_presentation_v1"
    if extended:
        from .swing_sr import empty_statistics, statistics

        stats, current = empty_statistics(), {"high": None, "low": None}
    # A missing interval breaks recursive state, even when its next bar is complete.
    mask = np.array([row["complete"] for row in rows], dtype=bool)
    edges = list(np.flatnonzero(np.diff(np.r_[False, mask, False])))
    spans = []
    for start, end in zip(edges[::2], edges[1::2]):
        cuts = [start] + [i for i in range(start + 1, end) if rows[i].get("gap_before")] + [end]
        spans.extend(zip(cuts, cuts[1:]))
    for start, end in spans:
        start, end = int(start), int(end)
        span = {key: values[start:end] for key, values in arrays.items()}
        values, display = _run(name, span, p)
        for key, output in values.items():
            outputs[key][start:end] = output
        if extended:
            previous = {"high": None, "low": None}
            current = {"high": None, "low": None}
            for event in display["events"]:
                side, pivot, detected = event["side"], start + event["pivot_time"], start + event["detected_bar_time"]
                item = stats[side]
                preview = rows[detected]["start"] == provisional_time
                if previous[side] is not None:
                    item["interval_sum"] += pivot - previous[side]
                    item["interval_count"] += 1
                item["event_count"] += 1
                item["preview_count" if preview else "confirmed_count"] += 1
                previous[side] = pivot
                current[side] = {"price": event["price"], "pivot_time": rows[pivot]["start"],
                                 "detected_bar_time": rows[detected]["start"],
                                 "confirmed_at": None if preview else rows[detected].get("end"),
                                 "provisional": preview}
                if "chart_time" in rows[pivot]:
                    current[side]["pivot_chart_time"] = rows[pivot]["chart_time"]
    result = {
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
                     **({"break_before": True} if row.get("gap_before") else {}),
                     **({"provisional": True} if row["start"] == provisional_time else {})}
                    for row, v in zip(rows, values)
                ],
            }
            for key, values in outputs.items()
        ],
    }
    if extended:
        if not rows:
            current = {"high": None, "low": None}
        # Disabling the final live preview retains the last confirmed display.
        # An incomplete historical candle still resets the next complete span.
        as_of = next((row["start"] for row, valid in zip(reversed(rows), reversed(mask))
                      if valid), None)
        result["presentation"] = {"render_profile": CATALOG[name]["render_profile"],
                                  "as_of_bar_time": as_of,
                                  "statistics_origin": rows[0]["start"] if rows else None,
                                  "current": current, "statistics": statistics(stats)}
        chart_row = next((row for row in reversed(rows) if row["start"] == as_of), None)
        if chart_row and "chart_time" in chart_row:
            result["presentation"]["as_of_chart_time"] = chart_row["chart_time"]
    return result


# Explicit registration on module load also covers independent market workers.
from .swing_sr import register_indicator  # noqa: E402

register_indicator()


# Import-time registration also covers workers/exports that never start the API.
from .supertrend_pine import METADATA as _SUPERTREND_METADATA  # noqa: E402
from .supertrend_pine import NAME as _SUPERTREND_NAME  # noqa: E402
from .supertrend_pine import calculate as _supertrend_calculate  # noqa: E402

register(_SUPERTREND_NAME, _SUPERTREND_METADATA, _supertrend_calculate)
