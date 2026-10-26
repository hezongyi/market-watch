"""Common input segmentation for graph and alert calculators."""

from .calendar_profile import closures_from
from .chart_history_plan import bucket_has_trading
from .domain import Calendar
from .storage import instant


def calculation_rows(rows, meta, instrument, timeframe=None, *, infer_gaps=True):
    result = [{**row, "indicator_calendar": meta["calendar"],
               "indicator_timezone": meta.get("timezone"), "indicator_session": meta.get("session"),
               "indicator_timeframe": timeframe} for row in rows]
    if timeframe and meta["calendar"] in ("ny17", "utc0"):
        from .provider_chart import label

        for row in result:
            row.setdefault("chart_time", label(row["start"], timeframe, meta["calendar"]))
    # Observed-bar indicators count existing candles, including across holidays.
    # Keep explicit invalid/gap flags; do not invent resets from elapsed time.
    if not infer_gaps or meta["calendar"] not in ("ny17", "utc0"):
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
