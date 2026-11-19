"""Durable small aggregation slices; focus changes affect the next selection."""

from itertools import groupby

from sqlalchemy import String, case, column, func, select, true, tuple_, values

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
        from .publication_wakeup import notify_derivation
        notify_derivation(db)


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


def _select_job(db, now):
    from .generic_derivation import runnable_aggregation

    model, demand, state = ChartAggregationJob, ChartViewportDemand, ChartAggregationState
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
    # Within the same urgency, refreshes must yield to the repairs they read.
    kind_order = case((model.kind == 'price', 0), (model.kind == 'volume', 1), else_=2)
    range_order = case((aged, model.created_at), else_=-model.end)
    service_turn = func.coalesce(state.last_service_seq, 0)
    runnable = runnable_aggregation(now)
    ranked = select(model, Instrument).join(Instrument,
        Instrument.id == model.instrument_id).outerjoin(state,
            (state.instrument_id == model.instrument_id) & (state.timeframe == model.timeframe)
        ).where(model.next_at <= now, runnable).order_by(
            service_turn, priority, kind_order, range_order, model.created_at, model.start, model.id
        ).limit(1).with_for_update(of=Instrument, skip_locked=True)
    if db.get_bind().dialect.name != 'postgresql':
        return db.execute(ranked).first()

    # Probe each supported target through the existing instrument/period index.
    # A correlated LIMIT keeps this a first-match lookup even with a deep queue.
    periods = values(column('timeframe', String(8)), name='aggregation_periods').data(
        [(frame,) for frame in PERIODS])
    ready = (select(model.start)
        .where(model.instrument_id == Instrument.id, model.timeframe == periods.c.timeframe,
               model.next_at <= now, runnable)
        .order_by(model.start).limit(1).correlate(Instrument, periods).scalar_subquery())
    targets = db.execute(select(Instrument.id, periods.c.timeframe, service_turn.label('turn'))
        .select_from(Instrument).join(periods, true()).outerjoin(state,
            (state.instrument_id == Instrument.id) & (state.timeframe == periods.c.timeframe))
        .where(ready.is_not(None)).order_by(service_turn)).all()
    # All jobs in a target share its service turn. Rank only the earliest tied
    # targets, and advance past a group if its instruments are locked or stale.
    for turn, group in groupby(targets, key=lambda target: target.turn):
        pairs = [(ident, frame) for ident, frame, _ in group]
        if len(pairs) > 1 and len(pairs) == len(targets):
            # A wholly new backlog has no service order to narrow by yet.
            return db.execute(ranked).first()
        selected = db.execute(ranked.where(service_turn == turn,
            tuple_(model.instrument_id, model.timeframe).in_(pairs))).first()
        if selected is not None:
            return selected
    return None


def _slice_bounds(job, calendar, *, cutoff=None):
    from .domain import bucket_bounds
    from .storage import instant, ms

    first, last = bucket_bounds(instant(job.start), job.timeframe, calendar)
    if cutoff is None:
        cutoff = ms(last)
        if job.timeframe not in ('H4', 'D1'):
            cutoff = max(cutoff, job.start + 120 * 60000)
    end = min(job.end, cutoff)
    right = ms(bucket_bounds(instant(end - 1), job.timeframe, calendar)[1])
    return min(job.end, right), ms(first), right


def _batch(db, job, calendar, now, available):
    from .domain import session_bounds
    from .storage import instant, ms

    # Leave recent adjustments, observations, and retries at the normal cadence.
    if job.kind != 'price' or job.end > now - MAX_RANGE or job.attempts:
        return [(job, *_slice_bounds(job, calendar))]
    start, end = (ms(at) for at in session_bounds(instant(job.start), calendar))
    if (end - start) // 60000 > available:
        return [(job, *_slice_bounds(job, calendar))]

    model = ChartAggregationJob
    following_end = ms(session_bounds(instant(end), calendar)[1])
    cutoff = following_end if (following_end - start) // 60000 <= available else end
    plans = [(job, *_slice_bounds(job, calendar, cutoff=cutoff))]
    eligible = select(model).where(
        model.instrument_id == job.instrument_id, model.kind == 'price',
        model.timeframe.in_(PERIODS), model.end <= now - MAX_RANGE,
        model.next_at <= now, model.attempts == 0,
    ).order_by(model.timeframe, model.start, model.end).limit(20).with_for_update(skip_locked=True)
    # Allow one range per frame in each session. A range crossing the boundary
    # can consume its own prefix in both, even if the provider used UTC pages.
    for left, right, frames in ((start, end, {job.timeframe}), (end, cutoff, set())):
        if right <= left:
            continue
        for sibling in db.scalars(eligible.where(model.start >= left, model.start < right)):
            if sibling.timeframe not in frames:
                plans.append((sibling, *_slice_bounds(sibling, calendar, cutoff=cutoff)))
                frames.add(sibling.timeframe)
    plans.sort(key=lambda plan: PERIODS.index(plan[0].timeframe))
    return plans


def aggregate_once():
    from .market import aggregate_touched
    from .publication_budget import current
    from .storage import now_ms, transaction

    with transaction() as db:
        now = now_ms()
        selected = _select_job(db, now)
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
        from .domain import calendar_for
        from .storage import instant

        budget = current()
        available = budget.available if budget else 4096
        plans = _batch(db, job, calendar_for(inst), now, available)
        needed = (max(right for _, _, _, right in plans)
                  - min(left for _, _, left, _ in plans)) // 60000
        if needed > available:
            return False
        from .source_history_store import _insert
        state = ChartAggregationState
        touched_by_frame = {}
        for item, end, _, _ in plans:
            touched_by_frame.setdefault(item.timeframe, set()).update(
                instant(at) for at in range(item.start, end, 60000))
        for frame in touched_by_frame:
            target = db.get(state, (inst.id, frame))
            if target is None:
                db.execute(_insert(db)(state).values(instrument_id=inst.id, timeframe=frame
                    ).on_conflict_do_nothing(index_elements=['instrument_id', 'timeframe']))
                target = db.get(state, (inst.id, frame))
            target.last_service_seq = (db.scalar(AGGREGATION_SERVICE_SEQUENCE.next_value())
                if db.get_bind().dialect.name == 'postgresql' else
                (db.scalar(select(func.max(state.last_service_seq))) or 0) + 1)
        try:
            # A failed calculation/write must not publish any partial aggregate.
            # Keep the outer transaction usable to persist retry state.
            with db.begin_nested():
                refreshed = aggregate_touched(db, inst, touched_by_frame[job.timeframe],
                    received_at=now, timeframes=tuple(touched_by_frame), kind=job.kind,
                    touched_by_frame=touched_by_frame if len(plans) > 1 else None)
                if job.kind == 'observed' and refreshed is False:
                    # A content repair owns these inputs. Preserve this freshness
                    # request until that repair commits, without counting failure.
                    job.next_at = now + 1000
                    return True
                from .publication_schedule import AGGREGATED, request, source_frames
                if job.kind != 'observed':
                    frames = sorted({frame for item, *_ in plans for frame in source_frames(item.timeframe)})
                    request(db, inst.id, frames=frames, reason=AGGREGATED, stamp=now)
                for item, slice_end, _, _ in plans:
                    if slice_end < item.end:
                        remaining = db.scalar(select(ChartAggregationJob).where(
                            ChartAggregationJob.instrument_id == inst.id,
                            ChartAggregationJob.timeframe == item.timeframe,
                            ChartAggregationJob.start == slice_end,
                            ChartAggregationJob.end == item.end))
                        if remaining is None:
                            db.add(ChartAggregationJob(instrument_id=inst.id,
                                timeframe=item.timeframe, start=slice_end, end=item.end,
                                created_at=item.created_at, kind=item.kind))
                        elif item.kind == 'price' or item.kind == 'volume' and remaining.kind == 'observed':
                            remaining.kind = item.kind
                    db.delete(item)
                db.flush()
                if job.kind == 'observed':
                    _, _, left, right = plans[0]
                    _wake_unblocked_publications(db, inst, job.timeframe, left, right)
        except Exception as error:
            # Keep siblings runnable. Retrying the selected job alone lets a
            # bad timeframe fall back to the normal retry path.
            job.attempts += 1
            job.next_at = now + min(300_000, 1000 * 2 ** min(job.attempts, 9))
            job.error = type(error).__name__

    return True
