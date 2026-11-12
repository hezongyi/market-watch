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
MAX_RANGE = 1440 * 60000


def _coalesce_observed(db, instrument, frame, left, right, *, kind='observed', all_kinds=False):
    """The caller owns Instrument; retain bounded ranges and durable retry age."""
    model = ChartAggregationJob
    rows = list(db.scalars(select(model).where(
        model.instrument_id == instrument, model.timeframe == frame,
        True if all_kinds else model.kind == 'observed',
        model.start <= right, model.end >= left).order_by(model.created_at, model.id).limit(128)))
    merged = []
    for row in rows:
        a, b = min(left, row.start), max(right, row.end)
        if b - a <= MAX_RANGE:
            left, right = a, b
            merged.append(row)
    if not merged:
        return None
    target = db.scalar(select(model).where(model.instrument_id == instrument,
        model.timeframe == frame, model.start == left, model.end == right))
    target = target or merged[0]
    if target not in merged:
        merged.append(target)
    strongest = max([kind, *(row.kind for row in merged)],
                    key=lambda value: {'observed': 0, 'volume': 1, 'price': 2}[value])
    created_at = min(row.created_at for row in merged)
    retry = max(merged, key=lambda row: (row.attempts, row.next_at))
    attempts, error = retry.attempts, retry.error
    next_at = max(row.next_at for row in merged)
    for row in merged:
        if row is not target:
            db.delete(row)
    # Release conflicting old unique keys before moving the retained range.
    db.flush()
    target.start, target.end = left, right
    target.kind = strongest
    target.created_at = min(target.created_at, created_at)
    target.attempts = max(target.attempts, attempts)
    target.next_at = max(target.next_at, next_at)
    if error:
        target.error = error
    db.flush()
    return target


def enqueue_aggregation(db, instrument, start, end, now, *, kind="price"):
    """Caller owns the instrument lock and commits this alongside M1 coverage."""
    from .generic_derivation import is_paused
    paused = is_paused(db, instrument)
    for left in range(start, end, MAX_RANGE):
        right = min(end, left + MAX_RANGE)
        for frame in PERIODS:
            if (paused or kind == 'observed') and _coalesce_observed(
                    db, instrument, frame, left, right, kind=kind, all_kinds=paused):
                continue
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


def _wake_unblocked_publications(db, inst, frame, left, right):
    """A prior changed snapshot may have waited on this now-removed barrier."""
    from sqlalchemy import or_

    from .publication_schedule import request, source_frames
    from .storage import ChartPublicationJob, ChartPublicationState

    state, dirty = ChartPublicationState, ChartPublicationJob
    frames = list(db.scalars(select(state.timeframe).where(state.instrument_id == inst.id,
        state.timeframe.in_(source_frames(frame)), state.attempts == 0,
        or_(state.requested == state.processed, state.blocked_reason.in_(('source', 'aggregation'))),
        select(dirty.start).where(dirty.instrument_id == state.instrument_id,
            dirty.timeframe == state.timeframe, dirty.start < right, dirty.end > left).exists())))
    if frames:
        request(db, inst.id, frames=frames)


def aggregate_once():
    from .generic_derivation import paused_query
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
            ).where(model.next_at <= now, model.instrument_id.not_in(paused_query(now))).order_by(
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
        if job.kind == 'observed':
            job = _coalesce_observed(db, inst.id, job.timeframe, job.start, job.end) or job
            if job.next_at > now:
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
                refreshed = aggregate_touched(db, inst, touched, received_at=now,
                                             timeframes=(job.timeframe,), kind=job.kind)
                if job.kind == 'observed' and refreshed is False:
                    # A content repair owns these inputs. Preserve this freshness
                    # request until that repair commits, without counting failure.
                    job.next_at = now + 1000
                    return True
                from .publication_schedule import AGGREGATED, request, source_frames
                if job.kind != 'observed':
                    # Observation writers request publication only on a real
                    # change; an obsolete duplicate job has nothing to publish.
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
                if job.kind == 'observed':
                    _wake_unblocked_publications(db, inst, job.timeframe, source_left, source_right)
        except Exception as error:
            job.attempts += 1
            job.next_at = now + min(300_000, 1000 * 2 ** min(job.attempts, 9))
            job.error = type(error).__name__

    return True
