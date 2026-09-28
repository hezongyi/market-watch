"""Read-only closed-bucket coverage audit; no provider requests or calendar edits."""

import argparse
import json
from datetime import UTC, datetime

from alerts.calendar_profile import closures_from
from alerts.domain import Calendar, bucket_bounds, has_trading_gap
from alerts.storage import Bar, Instrument, instant, transaction
from sqlalchemy import func, select


def audit(db, symbol):
    inst = db.get(Instrument, symbol)
    if inst is None:
        raise ValueError("Unknown instrument")
    first, last = db.execute(
        select(func.min(Bar.start), func.max(Bar.end)).where(
            Bar.instrument_id == symbol, Bar.timeframe == "M1", Bar.complete.is_(True)
        )
    ).one()
    if first is None:
        return {"instrument": symbol, "status": "no M1 data"}
    calendar = Calendar(inst.calendar)
    closures = closures_from(inst.calendar_profile)
    report = {
        "instrument": symbol,
        "calendar_revision": (inst.calendar_profile or {}).get("revision"),
        "first_m1": instant(first).isoformat(),
        "last_m1_end": instant(last).isoformat(),
        "timeframes": {},
    }
    for frame in ("M5", "M15", "H1", "H4", "D1"):
        stored = dict(db.execute(select(Bar.start, Bar.complete).where(
            Bar.instrument_id == symbol, Bar.timeframe == frame
        )).all())
        counts = {"complete": 0, "incomplete": 0, "missing_open": 0, "missing_closed": 0}
        examples = []
        left, right = bucket_bounds(instant(first), frame, calendar)
        # Do not confuse a partial first bucket or a still-forming last bucket with an internal gap.
        if left < instant(first):
            left, right = bucket_bounds(right, frame, calendar)
        while right <= instant(last):
            status = stored.get(int(left.timestamp() * 1000))
            if status is not None:
                outcome = "complete" if status else "incomplete"
            else:
                outcome = "missing_open" if has_trading_gap(
                    left, right, calendar, gold=symbol == "XAUUSD", closures=closures
                ) else "missing_closed"
            counts[outcome] += 1
            if outcome in ("incomplete", "missing_open") and len(examples) < 20:
                examples.append({"start": left.isoformat(), "end": right.isoformat(), "status": outcome})
            left, right = bucket_bounds(right, frame, calendar)
        report["timeframes"][frame] = {**counts, "examples_first_20": examples}
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--instrument", choices=["EURUSD", "XAUUSD", "BTCUSDT"], required=True)
    args = parser.parse_args()
    with transaction() as db:
        result = audit(db, args.instrument)
    print(json.dumps({
        "checked_at": datetime.now(UTC).isoformat(),
        "meaning": "Full stored M1 span; excludes partial boundary buckets; missing closed buckets are expected",
        "limitations": "Does not prove every expected M1 quote was published by the provider or validate OHLC prices",
        "result": result,
    }, ensure_ascii=False, indent=2))
