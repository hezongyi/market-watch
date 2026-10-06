"""Alert adapter over the chart's pure calculators, with a pinned input origin."""

from decimal import Decimal

from .chart_alert_domain import Operand, line_value
from .chart_indicators import calculate


def operand_values(rows, operand: Operand, *, provisional=False, indices=None):
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
    temporary = [{**row, "complete": True} if provisional and i == len(rows) - 1 else dict(row)
                 for i, row in enumerate(rows)]
    result = calculate(temporary, operand.indicator.model_dump())
    output = next(series for series in result["series"] if series["key"] == operand.indicator.output)
    return [Decimal(str(point["value"])) if point["value"] is not None else None
            for point in output["values"]]
