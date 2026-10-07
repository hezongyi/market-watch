"""Bounded coverage migration and preparations for the previous publisher."""

import argparse
import json

from sqlalchemy import select

from .chart_data import FRAMES
from .source_history_store import _insert
from .storage import (
    ChartPublication,
    ChartPublicationJob,
    ChartPublishedBar,
    Instrument,
    transaction,
)


def prepare_rollback_page(db, inst, frame, *, after=-1, limit=500):
    """Call with writers stopped; no snapshot or new request is acknowledged."""
    if frame not in FRAMES or not 1 <= limit <= 2000:
        raise ValueError('Rollback preparation requires a supported frame and bounded page')
    db.scalar(select(Instrument).where(Instrument.id == inst.id).with_for_update())
    rows = list(db.scalars(select(ChartPublishedBar).where(
        ChartPublishedBar.instrument_id == inst.id, ChartPublishedBar.timeframe == frame,
        ChartPublishedBar.start > after).order_by(ChartPublishedBar.start).limit(limit)))
    if rows:
        db.execute(_insert(db)(ChartPublicationJob).values([
            dict(instrument_id=inst.id, timeframe=frame, start=row.start, end=row.end)
            for row in rows]).on_conflict_do_nothing(index_elements=['instrument_id', 'timeframe', 'start']))
    return dict(examined=len(rows), after=rows[-1].start if rows else after, complete=len(rows) < limit)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    coverage = commands.add_parser('coverage')
    coverage.add_argument('--instrument', required=True)
    coverage.add_argument('--limit', type=int, default=500)
    coverage.add_argument('--until-complete', action='store_true')
    coverage.add_argument('--verify', action='store_true',
        help='Maintenance operation: final raw union verification may scan all proofs under the identity lock')
    rollback = commands.add_parser('prepare-rollback')
    rollback.add_argument('--workers-stopped', action='store_true', required=True,
                          help='Writers and publisher must be stopped before preparing old bucket jobs')
    args = parser.parse_args()
    if args.command == 'coverage':
        from .coverage_projection import backfill_page
        while True:
            with transaction() as db:
                inst = db.get(Instrument, args.instrument)
                if inst is None:
                    raise ValueError('Unknown instrument')
                result = backfill_page(db, inst, limit=args.limit, administrative=args.verify)
            print(json.dumps(dict(instrument=args.instrument, **result)), flush=True)
            if result['complete'] or result.get('maintenance_required') or not args.until_complete:
                return
    else:
        from .coverage_projection import invalidate_for_rollback
        from .storage import MarketCoverageCheckpoint
        # Include identities with proof checkpoints but no visible publication.
        # The previous writer does not maintain any of the additive projections.
        after = ''
        while True:
            with transaction() as db:
                identities = select(ChartPublication.instrument_id).union(
                    select(MarketCoverageCheckpoint.instrument_id)).subquery()
                page = list(db.scalars(select(identities.c.instrument_id).where(
                    identities.c.instrument_id > after).order_by(identities.c.instrument_id).limit(100)))
            for ident in page:
                with transaction() as db:
                    invalidate_for_rollback(db, db.get(Instrument, ident))
            if len(page) < 100:
                break
            after = page[-1]
        with transaction() as db:
            targets = list(db.execute(select(ChartPublication.instrument_id, ChartPublication.timeframe)))
        for ident, frame in targets:
            after = -1
            while True:
                with transaction() as db:
                    result = prepare_rollback_page(db, db.get(Instrument, ident), frame, after=after)
                print(json.dumps(dict(instrument=ident, timeframe=frame, **result)), flush=True)
                after = result['after']
                if result['complete']:
                    break


if __name__ == '__main__':
    main()
