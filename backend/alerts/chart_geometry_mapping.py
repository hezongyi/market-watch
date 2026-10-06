"""One timestamp/index mapping for drawing saves and persistent evaluation."""

from types import SimpleNamespace

from .chart_data import future_grid
from .chart_labels import managed_label
from .provider_chart import label


def bar_indices(rows, *, instrument, timeframe, series_kind, meta, future=False):
    known = {row.get("chart_time", managed_label(row, timeframe, instrument)): index
             for index, row in enumerate(rows)}
    if rows and future:
        profile = SimpleNamespace(calendar=meta["calendar"], calendar_profile=meta.get("calendar_profile", {}), id=instrument)
        for index, slot in enumerate(future_grid(profile, timeframe, rows[-1]["end"], 500), len(rows)):
            time = label(slot["start"], timeframe, meta["calendar"]) if series_kind == "provider" else managed_label(slot, timeframe, instrument)
            known[time] = index
    return known
