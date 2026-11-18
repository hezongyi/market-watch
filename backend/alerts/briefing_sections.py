"""Small section registry. Pure calculations; never send, persist or schedule."""

from collections import Counter
from decimal import Decimal, InvalidOperation


def daily_change(inputs, parameters=None):
    items = []
    for value in inputs:
        item = {key: val for key, val in value.items() if key != "rows"}
        rows = value.get("rows", [])
        if value["status"] in ("ok", "not_updated") and len(rows) == 2:
            try:
                for row in rows:
                    numbers = [Decimal(str(row[key])) for key in ("open", "high", "low", "close")]
                    if (
                        not all(x.is_finite() for x in numbers)
                        or numbers[1] < max(numbers[0], numbers[3])
                        or numbers[2] > min(numbers[0], numbers[3])
                    ):
                        raise ValueError("确认日线价格无效")
                previous, latest = (Decimal(str(row["close"])) for row in rows)
                change = latest - previous
                pct = change / previous * 100 if previous > 0 else None
                item.update(
                    change=str(change),
                    change_pct=str(pct if pct else Decimal(0)) if pct is not None else None,
                    previous_close=str(previous),
                    close=str(latest),
                    trading_date=rows[-1]["trading_date"],
                    previous_trading_date=rows[0]["trading_date"],
                    data_end=rows[-1]["end"],
                    bars=rows,
                )
                if previous <= 0:
                    item.update(status="source_error", reason="前收非正，仅显示绝对变动")
            except (InvalidOperation, ValueError, KeyError) as exc:
                item.update(status="source_error", reason=str(exc))
        items.append(item)
    coverage = dict(Counter(item["status"] for item in items))
    return {
        "id": "daily_change",
        "version": 1,
        "title": "最近交易日涨跌",
        "kind": "daily_change",
        "items": items,
        "coverage": coverage,
    }


REGISTRY = {"daily_change": daily_change}


def compute(specs, inputs):
    sections = []
    for spec in specs:
        try:
            sections.append(REGISTRY[spec["id"]](inputs, spec.get("parameters", {})))
        except Exception:
            sections.append(
                {
                    "id": spec["id"],
                    "version": spec["version"],
                    "kind": "error",
                    "title": "栏目暂不可用",
                    "items": [],
                    "coverage": {},
                    "error": "栏目计算失败",
                }
            )
    return sections
