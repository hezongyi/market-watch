"""Durable small aggregation slices; focus changes affect the next selection."""
from sqlalchemy import case, func, select

from .storage import (
    AGGREGATION_SERVICE_SEQUENCE,
    ChartAggregationJob,
    ChartAggregationState,
    ChartViewportDemand,
    Instrument,
)

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
    if end > start:
        from .publication_wakeup import notify
        notify(db)


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
    from .publication_budget import current
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
        state = ChartAggregationState
        # A whole backlog shares its target's last service turn. Keeping the
        # original job age for within-target priority must not let every old
        # slice take a turn ahead of an unrelated ready target.
        selected = db.execute(select(model, Instrument).join(Instrument,
            Instrument.id == model.instrument_id).outerjoin(state,
                (state.instrument_id == model.instrument_id) & (state.timeframe == model.timeframe)
            ).where(model.next_at <= now).order_by(
                func.coalesce(state.last_service_seq, 0), priority,
                case((aged, model.created_at), else_=-model.end), model.created_at, model.id)
            .limit(1).with_for_update(of=Instrument, skip_locked=True)).first()
        if selected is None:
            return False
        job, inst = selected
        job = db.scalar(select(ChartAggregationJob).where(
            ChartAggregationJob.id == job.id).with_for_update().execution_options(populate_existing=True))
        if job is None or job.next_at > now:
            return True
        from .domain import bucket_bounds, calendar_for
        from .storage import ms
        budget = current()
        # Complete buckets only: the largest indivisible D1 uses <=1500 source
        # minutes across DST. No partial bucket is persisted as complete.
        frame_end = ms(bucket_bounds(instant(job.start), job.timeframe, calendar_for(inst))[1])
        slice_end = min(job.end, frame_end if job.timeframe in ('H4','D1') else
                        max(frame_end, job.start + 120 * 60000))
        slice_end = min(job.end, ms(bucket_bounds(instant(slice_end - 1),
            job.timeframe, calendar_for(inst))[1]))
        source_left = ms(bucket_bounds(instant(job.start), job.timeframe, calendar_for(inst))[0])
        source_right = ms(bucket_bounds(instant(slice_end - 1), job.timeframe, calendar_for(inst))[1])
        needed = (source_right - source_left) // 60000
        if budget and budget.available < needed:
            return False
        from .source_history_store import _insert
        db.execute(_insert(db)(state).values(instrument_id=inst.id, timeframe=job.timeframe
            ).on_conflict_do_nothing(index_elements=['instrument_id', 'timeframe']))
        target = db.get(state, (inst.id, job.timeframe))
        target.last_service_seq = (db.scalar(AGGREGATION_SERVICE_SEQUENCE.next_value())
            if db.get_bind().dialect.name == 'postgresql' else
            (db.scalar(select(func.max(state.last_service_seq))) or 0) + 1)
        touched = {instant(at) for at in range(job.start, slice_end, 60000)}
        try:
            # A failed calculation/write must not publish any partial aggregate.
            # Keep the outer transaction usable to persist retry state.
            with db.begin_nested():
                aggregate_touched(db, inst, touched, received_at=now, timeframes=(job.timeframe,), kind=job.kind)
                from .publication_schedule import AGGREGATED, request, source_frames
                request(db, inst.id, frames=source_frames(job.timeframe), reason=AGGREGATED, stamp=now)
                if slice_end < job.end:
                    remaining = db.scalar(select(ChartAggregationJob).where(
                        ChartAggregationJob.instrument_id == inst.id,
                        ChartAggregationJob.timeframe == job.timeframe,
                        ChartAggregationJob.start == slice_end, ChartAggregationJob.end == job.end))
                    if remaining is None:
                        db.add(ChartAggregationJob(instrument_id=inst.id, timeframe=job.timeframe,
                            start=slice_end, end=job.end, created_at=job.created_at, kind=job.kind))
                    elif job.kind == 'price' or job.kind == 'volume' and remaining.kind == 'observed':
                        remaining.kind = job.kind
                db.delete(job)
                db.flush()
        except Exception as error:
            job.attempts += 1
            job.next_at = now + min(300_000, 1000 * 2 ** min(job.attempts, 9))
            job.error = type(error).__name__

    return True
