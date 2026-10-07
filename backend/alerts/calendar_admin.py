"""Review/apply a source-backed calendar profile during a maintenance window."""

import argparse
import json
from pathlib import Path

from sqlalchemy import select

from .calendar_profile import closures_from, normalized_profile
from .domain import bucket_bounds, calendar_for
from .storage import (
    Audit,
    Bar,
    ImportJob,
    Instrument,
    Watch,
    candle_dict,
    instant,
    ms,
    now_ms,
    transaction,
)


def apply_profile(db, instrument_id, data, *, apply=False):
    profile = normalized_profile(data)
    instrument = db.scalar(
        select(Instrument).where(Instrument.id == instrument_id).with_for_update()
    )
    if not instrument:
        raise ValueError("Unknown instrument")
    from .storage import MarketDataset

    if db.scalar(select(MarketDataset.id).where(MarketDataset.instrument_id == instrument_id)):
        raise ValueError("Explicit datasets require a new calendar identity; existing profiles cannot be changed")
    if profile.get("source_session"):
        raise ValueError("Source/account session rules require an explicit dataset registration")
    old = instrument.calendar_profile or {}
    if profile == old:
        return {"changed": False, "revision": profile["revision"]}
    if profile["revision"] == old.get("revision"):
        raise ValueError("A changed profile requires a new revision")
    if db.scalar(
        select(Watch.id)
        .where(Watch.instrument_id == instrument_id, Watch.status == "active")
        .limit(1)
    ):
        raise ValueError("Cancel active watches before changing their calendar")
    for closure in closures_from(profile):
        if db.scalar(
            select(Bar.id)
            .where(
                Bar.instrument_id == instrument_id,
                Bar.timeframe == "M1",
                Bar.start < ms(closure.end),
                Bar.end > ms(closure.start),
            )
            .limit(1)
        ):
            raise ValueError("Closure conflicts with stored M1 observations; verify the source")
    intervals = [(ms(c.start), ms(c.end)) for c in (*closures_from(old), *closures_from(profile))]
    affected = []
    repair = set()
    for left, right in intervals:
        affected.extend(
            db.scalars(
                select(Bar).where(
                    Bar.instrument_id == instrument_id,
                    Bar.timeframe != "M1",
                    Bar.start < right,
                    Bar.end > left,
                )
            ).all()
        )
        start = ms(bucket_bounds(instant(left), "D1", calendar_for(instrument))[0])
        end = min(
            ms(bucket_bounds(instant(right - 1), "D1", calendar_for(instrument))[1]),
            (now_ms() - 5000) // 60000 * 60000,
        )
        if start < end:
            repair.add((start, end))
    report = {
        "changed": True,
        "applied": apply,
        "revision": profile["revision"],
        "closures": len(profile["closures"]),
        "aggregate_rows_to_recheck": len({b.id for b in affected}),
        "repair_intervals": len(repair),
    }
    if apply:
        instrument.calendar_profile = profile
        from .publication_schedule import RULES, request
        request(db, instrument_id, reason=RULES)
        for bar in affected:
            if bar.complete:
                db.add(
                    Audit(
                        kind="candle_revision",
                        details={
                            "instrument": instrument_id,
                            "timeframe": bar.timeframe,
                            "previous": candle_dict(bar.candle()),
                            "cause": "calendar_profile_changed",
                        },
                    )
                )
                bar.complete = False
                bar.revision += 1
                from .publication_jobs import enqueue_publication
                enqueue_publication(db, instrument_id, bar.timeframe, {bar.start})
        for start, end in sorted(repair):
            db.add(
                ImportJob(
                    instrument_id=instrument_id, start=start, end=end, cursor=start, priority=0
                )
            )
        db.add(
            Audit(
                kind="calendar_profile_changed",
                details={
                    "instrument": instrument_id,
                    "previous": old,
                    "current": profile,
                    "report": report,
                },
            )
        )
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--instrument", required=True)
    parser.add_argument("--file", type=Path, required=True)
    parser.add_argument(
        "--apply", action="store_true", help="Without this flag, only validate and report"
    )
    args = parser.parse_args()
    with transaction() as db:
        print(
            json.dumps(
                apply_profile(
                    db, args.instrument, json.loads(args.file.read_text()), apply=args.apply
                ),
                ensure_ascii=False,
            )
        )


if __name__ == "__main__":
    main()
