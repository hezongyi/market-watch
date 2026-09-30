"""Durable small aggregation slices; focus changes affect the next selection."""
from sqlalchemy import select

from .storage import ChartAggregationJob, ChartViewportDemand, Instrument

PERIODS = ('M5', 'M15', 'H1', 'H4', 'D1')


def enqueue_aggregation(db, instrument, start, end, now):
    """Caller owns the instrument lock and commits this alongside M1 coverage."""
    for left in range(start, end, 1440 * 60000):
        right = min(end, left + 1440 * 60000)
        for frame in PERIODS:
            exists = db.scalar(select(ChartAggregationJob.id).where(
                ChartAggregationJob.instrument_id == instrument,
                ChartAggregationJob.timeframe == frame,
                ChartAggregationJob.start == left, ChartAggregationJob.end == right))
            if exists is None:
                db.add(ChartAggregationJob(instrument_id=instrument, timeframe=frame,
                                          start=left, end=right, created_at=now))
    db.flush()


def aggregation_priority(job, demands):
    priorities = [300]
    for demand in demands:
        if demand.instrument_id != job.instrument_id:
            continue
        priorities.append(170)
        # M30 is generated on read from persisted M15.
        frame = 'M15' if demand.timeframe == 'M30' else demand.timeframe
        if frame == job.timeframe and job.start < demand.end and job.end > demand.start:
            priorities.append(100 if demand.focused else 110)
        elif job.start < demand.end and job.end > demand.warm_start:
            priorities.append(130 if demand.focused else 150)
    return min(priorities), -job.end, job.created_at, job.id


def aggregate_once():
    from .market import aggregate_touched
    from .storage import instant, now_ms, transaction

    with transaction() as db:
        now = now_ms()
        demands = list(db.scalars(select(ChartViewportDemand).where(
            ChartViewportDemand.expires > now)))
        jobs = list(db.scalars(select(ChartAggregationJob)))
        if not jobs:
            return False
        job = min(jobs, key=lambda item: aggregation_priority(item, demands))
        # Match ingestion's lock order. Deletion and aggregate writes commit
        # together, so a crash leaves the pending slice available for retry.
        inst = db.scalar(select(Instrument).where(
            Instrument.id == job.instrument_id).with_for_update())
        job = db.scalar(select(ChartAggregationJob).where(
            ChartAggregationJob.id == job.id).with_for_update().execution_options(populate_existing=True))
        if job is None:
            return True
        touched = {instant(at) for at in range(job.start, job.end, 60000)}
        aggregate_touched(db, inst, touched, received_at=now, timeframes=(job.timeframe,))
        db.delete(job)
    return True
