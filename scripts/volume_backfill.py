"""Explicit upgrade start list and rollback fence; uses the configured isolated database."""
import argparse
import json

from alerts.storage import (
    Audit,
    ChartAggregationJob,
    ChartHistoryPlan,
    Instrument,
    VolumeBackfillJob,
    VolumeBackfillSegment,
    now_ms,
    transaction,
)
from alerts.volume_jobs import control, create, describe
from sqlalchemy import select


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('start-approved', 'start', 'list', 'rollback-fence'))
    parser.add_argument('--instrument')
    parser.add_argument('--start', type=int)
    parser.add_argument('--end', type=int)
    parser.add_argument('--apply', action='store_true', help='Commit starts/fences; default is a rollback-only preview')
    args = parser.parse_args()
    result = []
    with transaction() as db:
        if args.action == 'start-approved':
            for plan in db.scalars(select(ChartHistoryPlan).where(
                    ChartHistoryPlan.status != 'cancelled', ChartHistoryPlan.realtime_enabled.is_(True))):
                try:
                    job = create(db, plan.instrument_id, automatic=True)
                    if job:
                        result.append(describe(db, job))
                except ValueError as exc:
                    result.append(dict(instrument=plan.instrument_id, skipped=str(exc)))
        elif args.action == 'start':
            result.append(describe(db, create(db, args.instrument, start=args.start, end=args.end)))
        elif args.action == 'list':
            result = [describe(db, job) for job in db.scalars(select(VolumeBackfillJob))]
        else:
            # Workers MUST be stopped first. Serialize with ingestion/control and
            # revoke network leases before removing work selectable by old workers.
            for inst in db.scalars(select(Instrument).order_by(Instrument.id).with_for_update()):
                jobs = list(db.scalars(select(VolumeBackfillJob).where(
                    VolumeBackfillJob.instrument_id == inst.id)))
                for job in jobs:
                    if job.status in ('pending', 'running', 'partial', 'failed'):
                        control(db, job.id, 'cancel')
                for aggregate in db.scalars(select(ChartAggregationJob).where(
                        ChartAggregationJob.instrument_id == inst.id, ChartAggregationJob.kind == 'volume')):
                    owner = next((j for j in jobs if j.start < aggregate.end and j.end > aggregate.start), None)
                    if owner is None:
                        owner = VolumeBackfillJob(instrument_id=inst.id,
                            source=inst.source, symbol=inst.symbol, basis=inst.basis, calendar=inst.calendar,
                            calendar_profile=inst.calendar_profile, start=aggregate.start, end=aggregate.end,
                            cursor=aggregate.start, status='cancelled')
                        db.add(owner)
                        db.flush()
                        jobs.append(owner)
                    db.add(VolumeBackfillSegment(job_id=owner.id, start=aggregate.start, end=aggregate.end,
                        status='retry', detail='rollback aggregation '+aggregate.timeframe))
                    result.append(dict(job=owner.id, archived=aggregate.id, frame=aggregate.timeframe,
                        start=aggregate.start, end=aggregate.end))
                    db.delete(aggregate)
            db.add(Audit(kind='volume_rollback_fence', details=dict(at=now_ms(), archived=result)))
        if not args.apply and args.action != 'list':
            db.rollback()
    print(json.dumps(dict(applied=args.apply, jobs=result), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
