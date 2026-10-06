"""Common input segmentation for graph and alert calculators."""

from .calendar_profile import closures_from
from .chart_history_plan import bucket_has_trading
from .domain import Calendar
from .storage import instant


def calculation_rows(rows, meta, instrument):
    result = [dict(row) for row in rows]
    if meta["calendar"] not in ("ny17", "utc0"):
        return result
    calendar = Calendar(meta["calendar"])
    closures = closures_from(meta.get("calendar_profile"))
    for previous, row in zip(result, result[1:]):
        if row["start"] > previous["end"]:
            row["gap_before"] = bucket_has_trading(
                instant(previous["end"]), instant(row["start"]), calendar,
                instrument == "XAUUSD", closures,
            )
    return result
