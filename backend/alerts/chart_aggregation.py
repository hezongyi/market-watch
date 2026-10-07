"""Durable small aggregation slices; focus changes affect the next selection."""
from sqlalchemy import case, select

from .storage import ChartAggregationJob, ChartViewportDemand, Instrument

PERIODS = ('M5', 'M15', 'H1', 'H4', 'D1')


def enqueue_aggregation(db, instrument, start, end, now, *, kind="price"):
    """Caller owns the instrument lock and commits this alongside M1 coverage."""
    for left in range(start, end, 1440 * 60000):
        right = min(end, left + 1440 * 60000)
        for frame in PERIODS:
            exists = db.scalar(select(ChartAggregationJob).where(
                ChartAggregationJob.instrument_id == instrument,
                ChartAggregationJob.timeframe == frame,
                ChartAggregationJob.start == left, ChartAggregationJob.end == right))
            if exists is None:
                db.add(ChartAggregationJob(instrument_id=instrument, timeframe=frame,
                                          start=left, end=right, created_at=now, kind=kind))
            elif kind == "price":
                exists.kind = "price"
            elif kind == 'volume' and exists.kind == 'observed':
                exists.kind = 'volume'
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
        model, demand = ChartAggregationJob, ChartViewportDemand
        active = (demand.instrument_id == model.instrument_id, demand.expires > now)
        source = case((demand.timeframe == 'M30', 'M15'), else_=demand.timeframe)
        exact = (*active, source == model.timeframe, model.start < demand.end, model.end > demand.start)
        warm = (*active, model.start < demand.end, model.end > demand.warm_start)
        def exists(*conditions):
            return select(demand.id).where(*conditions).exists()
        aged = model.created_at <= now - 10000
        priority = case((aged, 0),
            (exists(*exact, demand.focused.is_(True)), 100), (exists(*exact), 110),
            (exists(*warm, demand.focused.is_(True)), 130), (exists(*warm), 150),
            (exists(*active), 170), else_=300)
        # Return one candidate and lock only its identity. Older jobs get a
        # service turn ahead of focus priority, and locked identities are skipped
        # inside the SQL selection rather than hiding the rest of the queue.
        selected = db.execute(select(model, Instrument).join(Instrument,
            Instrument.id == model.instrument_id).where(model.next_at <= now).order_by(
                priority, case((aged, model.created_at), else_=-model.end), model.created_at, model.id)
            .limit(1).with_for_update(of=Instrument, skip_locked=True)).first()
        if selected is None:
            return False
        job, inst = selected
        job = db.scalar(select(ChartAggregationJob).where(
            ChartAggregationJob.id == job.id).with_for_update().execution_options(populate_existing=True))
        if job is None or job.next_at > now:
            return True
        touched = {instant(at) for at in range(job.start, job.end, 60000)}
        try:
            # A failed calculation/write must not publish any partial aggregate.
            # Keep the outer transaction usable to persist retry state.
            with db.begin_nested():
                aggregate_touched(db, inst, touched, received_at=now, timeframes=(job.timeframe,), kind=job.kind)
                from .publication_schedule import AGGREGATED, request, source_frames
                request(db, inst.id, frames=source_frames(job.timeframe), reason=AGGREGATED, stamp=now)
                db.delete(job)
                db.flush()
        except Exception as error:
            job.attempts += 1
            job.next_at = now + min(300_000, 1000 * 2 ** min(job.attempts, 9))
            job.error = type(error).__name__

    return True
