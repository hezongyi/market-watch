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


def record_review(db, instrument_id, *, revision, reviewer, method, evidence_version, review_due_at):
    """Record an explicit review action separately from immutable applicability."""
    from datetime import date

    instrument = db.scalar(select(Instrument).where(Instrument.id == instrument_id).with_for_update())
    if not instrument or (instrument.calendar_profile or {}).get("revision") != revision:
        raise ValueError("Calendar review must name the current exact profile revision")
    if not all(isinstance(value, str) and 0 < len(value.strip()) <= 200
               for value in (reviewer, method, evidence_version)):
        raise ValueError("Review requires reviewer, method and evidence version")
    date.fromisoformat(review_due_at)
    event = Audit(kind="calendar_review", at=now_ms(), details={"instrument": instrument_id,
        "revision": revision, "reviewer": reviewer, "method": method,
        "evidence_version": evidence_version, "review_due_at": review_due_at})
    db.add(event)
    return event


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
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--file", type=Path, help="Validate or apply a new legacy calendar profile")
    action.add_argument("--record-review", metavar="REVISION", help="Record review of the exact current profile without changing it")
    parser.add_argument("--reviewer")
    parser.add_argument("--review-method")
    parser.add_argument("--evidence-version")
    parser.add_argument("--review-due")
    parser.add_argument(
        "--apply", action="store_true", help="Without this flag, only validate and report"
    )
    args = parser.parse_args()
    review = (args.reviewer, args.review_method, args.evidence_version, args.review_due)
    if any(review) and (not all(review) or not args.apply):
        parser.error("Review recording requires --apply and all four review fields")
    if args.record_review and not all(review):
        parser.error("--record-review requires --apply and all four review fields")
    with transaction() as db:
        data = json.loads(args.file.read_text()) if args.file else None
        report = (apply_profile(db, args.instrument, data, apply=args.apply) if args.file else
                  {"review_recorded": True, "revision": args.record_review})
        if all(review):
            record_review(db, args.instrument, revision=data["revision"] if args.file else args.record_review,
                reviewer=args.reviewer, method=args.review_method,
                evidence_version=args.evidence_version, review_due_at=args.review_due)
    # Report success only after the audit transaction committed.
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
