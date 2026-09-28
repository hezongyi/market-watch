"""Generate official trading instants for review, not M1 closure profiles.

Run with the optional calendar dependency installed. No database or network access.
"""

import argparse
import json
from datetime import date, time
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd
import pandas_market_calendars as mcal
from pandas_market_calendars.market_calendar import MarketCalendar

HOURS = "https://www.oanda.com/sg-en/trading/hours-of-operation/"
HOLIDAYS = "https://www.oanda.com/sg-en/trading/holiday-trading-hours/"


class OandaSingaporeGold(MarketCalendar):
    name = "OANDA_SG_GOLD_REVIEW"
    tz = ZoneInfo("America/New_York")
    regular_market_times = {
        "market_open": ((None, time(18, 5), -1),),
        "market_close": ((None, time(16, 59)),),
    }


def generate(start, end, *, include_verified_holidays=True):
    left, right = date.fromisoformat(start), date.fromisoformat(end)
    if right < left or (right - left).days > 366:
        raise ValueError("Choose an ordered range of at most 367 dates")
    if include_verified_holidays and not (
        date(2026, 4, 1) <= left <= right <= date(2026, 9, 28)
    ):
        raise ValueError("Reviewed holiday evidence covers 2026-04-01 through 2026-09-28")
    schedule = OandaSingaporeGold().schedule(start, end)
    early = {
        "2026-05-25": time(14, 29),
        "2026-06-19": time(12, 59),
        "2026-07-03": time(12, 59),
        "2026-09-07": time(14, 29),
    }
    rows = []
    for label, row in schedule.iterrows():
        day = label.date().isoformat()
        if include_verified_holidays and day == "2026-04-03":
            continue
        close = row.market_close
        special = include_verified_holidays and day in early
        if special:
            close = label.tz_localize("America/New_York") + pd.Timedelta(
                hours=early[day].hour, minutes=early[day].minute
            )
        rows.append({
            "session_date": day,
            "open": row.market_open.isoformat(),
            "close": close.tz_convert("UTC").isoformat(),
            "close_source": HOLIDAYS if special else HOURS,
        })
    return {
        "revision": "oanda-sg-official-instants-20260929-v1",
        "library": f"pandas_market_calendars=={mcal.__version__}",
        "instrument": "XAUUSD",
        "source": HOURS,
        "holiday_source": HOLIDAYS if include_verified_holidays else None,
        "range": [start, end],
        "purpose": "Official trading instants; NOT an M1 closure profile or NY17 bucket schedule",
        "limitations": [
            "Practice M1 observations overlap quoted boundary minutes; do not discard them",
            "Holiday reopen instants require separate review; rows use regular next-session open",
            "No claim that every minute has a quote",
        ],
        "sessions": rows,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start", required=True)
    parser.add_argument("--end", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = generate(args.start, args.end)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
