"""UTC trading-date labels used by the native chart for managed candles."""

from datetime import timedelta
from zoneinfo import ZoneInfo

from .storage import instant


def managed_label(row, frame, instrument):
    if frame not in ("D1", "W1", "MN"):
        return row["start"]
    crypto = instrument == "BTCUSDT"
    at = row["end"] - 1 if frame == "D1" else row["start"] + (0 if crypto else 86_400_000)
    day = instant(at).astimezone(ZoneInfo("Etc/UTC" if crypto else "America/New_York")).date()
    if frame == "MN":
        day = day.replace(day=1)
    return int((day - instant(0).date()) / timedelta(milliseconds=1))
