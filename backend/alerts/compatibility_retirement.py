"""Retire explicitly reviewed standalone replicas, preserving canonical inputs.

This is permanent per-instrument retirement, not an expiring demand or a live
source switch. Fixed histories and composite inputs keep their own identities.
"""

import argparse
import json

from sqlalchemy import delete, func, select

from .storage import (
    AdvancedPreference,
    AdvancedWorkspace,
    Audit,
    ChartAggregationJob,
    ChartAggregationState,
    ChartPublicationJob,
    ChartPublicationState,
    ChartWorkspace,
    Instrument,
    MarketDataset,
    Preference,
    now_ms,
    transaction,
)

PREFIX = "retired_compatibility:"
MESSAGE = "该独立行情入口已退役，请使用原生行情或自建行情"
TASKS = (ChartAggregationJob, ChartAggregationState, ChartPublicationJob, ChartPublicationState)


def retired_query():
    return select(Instrument.id).join(Preference, Preference.key == PREFIX + Instrument.id)


def retired(db, instrument):
    return db.get(Preference, PREFIX + instrument) is not None


def require_available(db, instrument):
    if retired(db, instrument):
        raise ValueError(MESSAGE)


def require_references(db, document):
    """Only direct standalone identities are retired; fixed/composite refs survive."""
    from .history_retention import string_values

    values = {v.removeprefix("MWP:") for v in string_values(document)}
    ids = {v for v in values if v.startswith("MD:")}
    if ids and db.scalar(retired_query().where(Instrument.id.in_(ids)).limit(1)):
        raise ValueError(MESSAGE)


def require_read(db, instrument):
    if retired(db, instrument):
        from .query_errors import QueryError

        raise QueryError(410, {"code": "SERIES_RETIRED", "message": MESSAGE})


def retire(db, instruments, *, apply=False):
    """Validate the complete explicit batch under writer locks before deleting tasks."""
    from .generic_derivation import independent_consumers, is_candidate

    ids = sorted(set(instruments))
    if not ids:
        raise ValueError("Specify the reviewed instruments explicitly")
    # Match the common saved-reference fence: all datasets by dataset id,
    # then instruments, rather than alternating locks in instrument order.
    list(
        db.scalars(
            select(MarketDataset.id)
            .where(MarketDataset.instrument_id.in_(ids))
            .order_by(MarketDataset.id)
            .with_for_update()
        )
    )
    list(
        db.scalars(
            select(Instrument.id)
            .where(Instrument.id.in_(ids))
            .order_by(Instrument.id)
            .with_for_update()
        )
    )
    report = []
    for ident in ids:
        done = retired(db, ident)
        if not done:
            if not is_candidate(db, ident):
                raise ValueError(
                    "Retirement requires an explicitly disabled mapped target: " + ident
                )
            if ident in set(db.scalars(independent_consumers(now_ms()))):
                raise ValueError("Independent consumer still references target: " + ident)
            # Saved chart/watchlist references need explicit migration, not a
            # silent change of provider or price identity. Never modify layouts.
            from .history_retention import reference_values, string_values

            if any(
                ident in {v.removeprefix("MWP:") for v in string_values(reference_values(row))}
                for model in (AdvancedPreference, AdvancedWorkspace, ChartWorkspace)
                for row in db.scalars(select(model))
            ):
                raise ValueError("Saved consumer still references target: " + ident)
        counts = {
            model.__tablename__: db.scalar(
                select(func.count()).select_from(model).where(model.instrument_id == ident)
            )
            for model in TASKS
        }
        report.append(dict(instrument=ident, already_retired=done, deleted=counts))
    if apply:
        for row in report:
            ident = row["instrument"]
            if not row["already_retired"]:
                db.add(Preference(key=PREFIX + ident, value={"retired_at": now_ms()}))
                db.add(Audit(kind="compatibility_replica_retired", details=row))
            for model in TASKS:
                db.execute(delete(model).where(model.instrument_id == ident))
        db.flush()
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--instrument", action="append", required=True)
    parser.add_argument("--apply", action="store_true", help="Default is read-only preview")
    args = parser.parse_args()
    with transaction() as db:
        print(
            json.dumps(
                {"applied": args.apply, "targets": retire(db, args.instrument, apply=args.apply)}
            )
        )


if __name__ == "__main__":
    main()
