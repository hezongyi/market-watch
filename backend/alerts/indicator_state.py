"""Bounded, serializable states for the built-in Python indicator contracts.

Start at the fixed series origin (or a verified checkpoint), never at a chart
page's warmup prefix. Confirmed updates mutate a state; provisional updates
operate on a copy. A missing dependency resets the valid span as in TA-Lib.
"""

import copy
import math

from .chart_indicators import CATALOG, validate
from .nr_breakout import ALGORITHM as NR_ALGORITHM
from .nr_breakout import NAME as NR_NAME
from .nr_breakout import step as nr_step
from .rolling_range_squeeze import ALGORITHM as SQUEEZE_ALGORITHM
from .rolling_range_squeeze import NAME as SQUEEZE_NAME
from .rolling_range_squeeze import SqueezeState
from .supertrend_pine import ALGORITHM as SUPERTREND_ALGORITHM
from .supertrend_pine import NAME as SUPERTREND_NAME
from .supertrend_pine import step as supertrend_step

ALGORITHM = "fixed-indicator-state-v3"
SUPPORTED = frozenset(("SMA", "EMA", "LWMA", "BBANDS", "RSI", "MACD", "ATR", "STOCH",
                       "SWING_SR_V1", SUPERTREND_NAME, SQUEEZE_NAME, NR_NAME))
ALGORITHMS = (ALGORITHM, SUPERTREND_ALGORITHM, SQUEEZE_ALGORITHM, NR_ALGORITHM)


def advance_dependencies(state, name, params, row):
    """Dependency evidence shared by state replay and the batch oracle path."""
    if row.get("gap_before") or not row["complete"]:
        state.clear()
    if not row["complete"]:
        return
    continued = bool(state)
    if not state:
        state.update(n=0, origin=row["start"], seam=False)
    touches_seam = bool(row.get("seam_crossing") or row.get("seam_at_start") and continued)
    state["seam"] |= touches_seam
    state["n"] += 1
    if name in ("SMA", "LWMA", "BBANDS", "STOCH"):
        length = (params["k"] + params["smooth"] + params["d"] - 2) if name == "STOCH" else params["period"]
        dependencies = state.setdefault("dependencies", [])
        dependencies.append([row["start"], touches_seam])
        if len(dependencies) > length:
            removed = dependencies.pop(0)
            if removed[1]:
                state["seam"] = any(item[1] for item in dependencies)
        state["origin"] = dependencies[0][0]
    state["last_end"] = row["end"]


class IndicatorState:
    def __init__(self, spec, checkpoint=None):
        self.name, self.params = validate(spec)
        if self.name not in SUPPORTED:
            raise ValueError("该指标尚未声明完整初始化与检查点算法")
        self.spec = {"name": self.name, "version": "1", "params": self.params}
        self.algorithm = SUPERTREND_ALGORITHM if self.name == SUPERTREND_NAME else ALGORITHM
        if self.name == SQUEEZE_NAME:
            self.algorithm = SQUEEZE_ALGORITHM
        if self.name == NR_NAME:
            self.algorithm = NR_ALGORITHM
        self.state = {}
        if checkpoint is not None:
            if (checkpoint.get("algorithm") != self.algorithm or checkpoint.get("spec") != self.spec):
                raise ValueError("指标检查点算法或参数不匹配")
            self.state = copy.deepcopy(checkpoint["state"])

    def checkpoint(self):
        return {"algorithm": self.algorithm, "spec": copy.deepcopy(self.spec),
                "state": copy.deepcopy(self.state)}

    def initialized(self, values):
        # Event/alternating plots intentionally contain null after warmup.
        if self.name == SUPERTREND_NAME:
            return self.state.get("atr") is not None
        if self.name == SQUEEZE_NAME:
            return values["threshold"] is not None and values["ratio"] is not None
        if self.name == NR_NAME:
            return bool(self.state.get("ranges"))
        return all(value is not None for value in values.values())

    def display_step(self, row, *, provisional_dependency=False):
        """Advance an isolated display chain, preserving preview event semantics.

        Callers own the copied state. This is deliberately separate from the
        one-row provisional trial used by alert evaluation.
        """
        if self.name == SQUEEZE_NAME:
            admitted = row.get('display_coverage_complete', not row.get('source_confirmed', row['complete']) or row['complete'])
            engine = SqueezeState(self.params, self.state or None, copy_state=False)
            values = engine.step({**row, 'complete': admitted},
                                 provisional=admitted and (provisional_dependency or not row['complete']))
            self.state, self.last_presentation = engine.state, engine.presentation()
            return values
        if self.name == 'SWING_SR_V1':
            from .swing_sr import SwingState

            engine = SwingState(self.params, self.state or None, copy_state=False)
            admitted = row.get('display_coverage_complete', not row.get('source_confirmed', row['complete']) or row['complete'])
            values, _ = engine.step({**row, 'complete': row['complete'] if admitted else False,
                'gap_before': row.get('gap_before') or not admitted},
                provisional=admitted and (provisional_dependency or not row['complete']))
            self.state, self.last_presentation = engine.state, engine.presentation()
            return values
        # Source-confirmed but incomplete coverage remains a real dependency
        # gap. Admission is for observed prices, not every incomplete bucket.
        admitted = row.get('display_coverage_complete', not row.get('source_confirmed', row['complete']) or row['complete'])
        return self.step({**row, 'complete': admitted})

    def step(self, row, *, provisional=False):
        if self.name == SQUEEZE_NAME:
            engine = SqueezeState(self.params, self.state or None, copy_state=provisional)
            values = engine.step(row, provisional=provisional)
            self.last_presentation = engine.presentation()
            if not provisional:
                self.state = engine.state
            return values
        if self.name == "SWING_SR_V1":
            from .swing_sr import SwingState

            # Confirmed state is owned by this IndicatorState. Only preview
            # needs isolation; cloning its rolling window per bar is quadratic
            # in the configured strength and adds no correctness boundary.
            engine = SwingState(self.params, self.state or None, copy_state=provisional)
            values, _ = engine.step(row, provisional=provisional)
            self.last_presentation = engine.presentation()
            if not provisional:
                self.state = engine.state
            return values
        if provisional:
            trial = IndicatorState(self.spec, self.checkpoint())
            return trial.step({**row, "complete": True})
        empty = dict.fromkeys(item["key"] for item in CATALOG[self.name]["series"])
        if row.get("gap_before"):
            self.state = {}
        if not row["complete"]:
            self.state = {}
            return empty
        high, low, close = (float(row[key]) for key in ("high", "low", "close"))
        if not all(math.isfinite(value) for value in (high, low, close)):
            raise ValueError("指标输入价格必须是有限数值")
        if self.name == SUPERTREND_NAME:
            try:
                open_ = float(row["open"])
            except (KeyError, TypeError, ValueError) as exc:
                raise ValueError(f"{self.name}: missing or invalid open input") from exc
            if not math.isfinite(open_):
                raise ValueError(f"{self.name}: open 必须是有限数值")
        s, p = self.state, self.params
        advance_dependencies(s, self.name, p, row)
        n = s["n"]
        if self.name == NR_NAME:
            result = nr_step(s, row, p)
        elif self.name == SUPERTREND_NAME:
            result = supertrend_step(s, open_, high, low, close, p)
        elif self.name in ("SMA", "LWMA", "BBANDS", "EMA"):
            period = p["period"]
            window = s.setdefault("window", [])
            if self.name == "EMA" and n > period:
                s["ema"] += (close - s["ema"]) * (2 / (period + 1))
                result = {"value": s["ema"]}
            else:
                window.append(close)
                if self.name in ("SMA", "BBANDS"):
                    s["sum"] = s.get("sum", 0.0) + close
                    s["squares"] = s.get("squares", 0.0) + close * close
                result = empty
                if len(window) == period:
                    if self.name == "EMA":
                        s["ema"] = sum(window) / period
                        result = {"value": s["ema"]}
                        window.clear()
                    elif self.name == "LWMA":
                        result = {"value": sum((i + 1) * value for i, value in enumerate(window)) /
                                  (period * (period + 1) / 2)}
                        window.pop(0)
                    else:
                        mean = s["sum"] / period
                        if self.name == "SMA":
                            result = {"value": mean}
                        else:
                            variance = s["squares"] / period - mean * mean
                            deviation = math.sqrt(max(0.0, variance)) * p["deviation"]
                            result = {"upper": mean + deviation, "middle": mean, "lower": mean - deviation}
                        old = window.pop(0)
                        s["sum"] -= old
                        s["squares"] -= old * old
        elif self.name in ("RSI", "ATR"):
            result = empty
            period = p["period"]
            if n > 1:
                if self.name == "RSI":
                    change = close - s["previous"]
                    measures = {"gain": max(change, 0.0), "loss": max(-change, 0.0)}
                else:
                    measures = {"tr": max(high - low, abs(high - s["previous"]), abs(low - s["previous"]))}
                for key, value in measures.items():
                    if n <= period + 1:
                        s[key] = s.get(key, 0.0) + value
                        if n == period + 1:
                            s[key] /= period
                    else:
                        s[key] = (s[key] * (period - 1) + value) / period
                if n >= period + 1:
                    total = s.get("gain", 0) + s.get("loss", 0)
                    result = {"value": s["tr"] if self.name == "ATR" else
                              (100 * (s["gain"] / total) if abs(total) >= 1e-8 else 0.0)}
        elif self.name == "MACD":
            result = empty
            if n <= p["slow"]:
                seed = s.setdefault("seed", [])
                seed.append(close)
                if n == p["slow"]:
                    s["slow"] = sum(seed) / p["slow"]
                    s["fast"] = sum(seed[-p["fast"]:]) / p["fast"]
                    del s["seed"]
            else:
                for key in ("fast", "slow"):
                    s[key] += (close - s[key]) * (2 / (p[key] + 1))
            if n >= p["slow"]:
                macd = s["fast"] - s["slow"]
                if n <= p["slow"] + p["signal"] - 1:
                    signals = s.setdefault("signals", [])
                    signals.append(macd)
                    if len(signals) == p["signal"]:
                        s["signal"] = sum(signals) / p["signal"]
                        del s["signals"]
                else:
                    s["signal"] += (macd - s["signal"]) * (2 / (p["signal"] + 1))
                if "signal" in s:
                    result = {"macd": macd, "signal": s["signal"], "histogram": macd - s["signal"]}
        else:  # STOCH: slow K is withheld until slow D is initialized, as in TA-Lib.
            result = empty
            window = s.setdefault("window", [])
            window.append([high, low])
            if len(window) > p["k"]:
                window.pop(0)
            if len(window) == p["k"]:
                highest, lowest = max(pair[0] for pair in window), min(pair[1] for pair in window)
                fast = 0.0 if highest == lowest else (close - lowest) / ((highest - lowest) / 100)
                ks = s.setdefault("ks", [])
                ks.append(fast)
                if len(ks) > p["smooth"]:
                    ks.pop(0)
                if len(ks) == p["smooth"]:
                    k = sum(ks) / p["smooth"]
                    ds = s.setdefault("ds", [])
                    ds.append(k)
                    if len(ds) > p["d"]:
                        ds.pop(0)
                    if len(ds) == p["d"]:
                        result = {"k": k, "d": sum(ds) / p["d"]}
        s["previous"], s["last_start"], s["last_end"] = close, row["start"], row["end"]
        return {key: value if value is None or math.isfinite(value) else None for key, value in result.items()}


def presentation(spec, rows, display=None):
    name, params = validate(spec)
    return {"name": name, "version": "1", "params": params, "pane": CATALOG[name]["pane"],
        **({"presentation": display} if display is not None else {}),
        "levels": CATALOG[name].get("levels", []), "series": [
            {**item, "values": [{"time": row["start"], "value": row["values"][item["key"]],
                **({"break_before": True} if row.get("break_before") else {}),
                **({"provisional": True} if row.get("provisional") else {})} for row in rows]}
            for item in CATALOG[name]["series"]]}
