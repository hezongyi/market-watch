"""Alert adapter over the chart's pure calculators, with a pinned input origin."""

import hashlib
import json
from decimal import Decimal

from .chart_alert_domain import Operand, line_value
from .chart_indicators import calculate


def operand_values(rows, operand: Operand, *, provisional=False, indices=None, cache=None):
    """A provisional final bar is recomputed, never committed into recursive state.

    `rows` must contain the same fixed origin and gap flags for chart and alert
    consumers. Earlier incomplete bars remain gaps; only the final live bar can
    be used as a temporary sample.
    """
    if operand.kind == "constant":
        return [operand.value] * len(rows)
    if operand.kind == "price":
        return [Decimal(str(row["close"])) if row["complete"] or provisional and i == len(rows) - 1
                else None for i, row in enumerate(rows)]
    if operand.kind == "line":
        if indices is None or len(indices) != len(rows):
            raise ValueError("画线判定需要经过核对的 K 线序号")
        return [line_value(operand.line, index) for index in indices]
    spec = operand.indicator.model_dump(exclude={"output"})
    if cache is None:
        result = calculate(rows, spec, provisional=provisional)
    else:
        digest = hashlib.sha256(json.dumps([
            [r["start"], r["high"], r["low"], r["close"], r["complete"], bool(r.get("gap_before"))]
            for r in rows
        ], separators=(",", ":"), default=str).encode()).hexdigest()
        key = (digest, provisional, json.dumps(spec, sort_keys=True))
        result = cache.get(key)
        if result is None:
            result = calculate(rows, spec, provisional=provisional)
            weight = sum(len(series["values"]) for series in result["series"])
            if weight <= 250_000:
                cache[key] = result
                while len(cache) > 32 or sum(len(s["values"]) for value in cache.values() for s in value["series"]) > 250_000:
                    cache.pop(next(iter(cache)))
    output = next(series for series in result["series"] if series["key"] == operand.indicator.output)
    return [Decimal(str(point["value"])) if point["value"] is not None else None
            for point in output["values"]]
