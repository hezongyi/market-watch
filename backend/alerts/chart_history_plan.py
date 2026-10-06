"""Shared durable history target, separate from cancellable browser requests."""
from datetime import timedelta

from sqlalchemy import select

from .calendar_profile import closures_from
from .chart_data import bounds
from .chart_series import is_gold
from .domain import Calendar, bucket_bounds, scheduled_open
from .storage import (
    ChartAggregationJob,
    ChartHistoryPlan,
    ChartViewportDemand,
    Instrument,
    instant,
    ms,
)

FRAMES = {"M1", "M5", "M15", "M30", "H1", "H4", "D1"}


def bucket_has_trading(left, right, calendar, gold, closures):
    # Weekly NY schedule transitions occur on whole hours; explicit closures
    # can end at arbitrary minutes. Probe every possible closed->open boundary
    # instead of scanning thousands of minutes against all closure records.
    candidates = [left]
    hour = left.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    while hour < right:
        candidates.append(hour)
        hour += timedelta(hours=1)
    candidates.extend(c.end for c in closures if left < c.end < right)
    return any(scheduled_open(at, calendar, gold=gold, closures=closures)
               for at in candidates if at < right)


def history_start(inst, timeframe, end, count):
    """Count scheduled buckets backwards, respecting NY DST and closures."""
    if timeframe not in FRAMES or not 1 <= count <= 6000:
        raise ValueError("Unsupported history window")
    calendar = Calendar(inst.calendar)
    closures = closures_from(inst.calendar_profile)
    cursor = instant(end)
    remaining = count
    # Bound malformed all-closed calendars instead of looping forever.
    for _ in range(count * 16 + 10000):
        probe = cursor - timedelta(microseconds=1)
        left, right = (bounds(probe, timeframe, calendar) if timeframe == "M30"
                       else bucket_bounds(probe, timeframe, calendar))
        if bucket_has_trading(left, min(right, cursor), calendar,
                              gold=is_gold(inst.id), closures=closures):
            remaining -= 1
        cursor = left
        if remaining == 0:
            return ms(left)
    raise ValueError("No sufficient scheduled trading history")


def history_end(inst, timeframe, start, count):
    """Forward counterpart for bounded pages near a historical navigation target."""
    if timeframe not in FRAMES or not 1 <= count <= 2000:
        raise ValueError("Unsupported navigation window")
    calendar = Calendar(inst.calendar)
    closures = closures_from(inst.calendar_profile)
    cursor = instant(start)
    for _ in range(count * 16 + 10000):
        left, right = (bounds(cursor, timeframe, calendar) if timeframe == "M30"
                       else bucket_bounds(cursor, timeframe, calendar))
        if bucket_has_trading(max(left, cursor), right, calendar,
                              gold=is_gold(inst.id), closures=closures):
            count -= 1
        cursor = right
        if count == 0:
            return ms(right)
    raise ValueError("No sufficient scheduled trading history")


def update_demand(db, *, ident, instrument, timeframe, end, visible, focused, now, required=None):
    """Viewport interest is read-only with respect to acquisition authorization."""
    if timeframe not in (*FRAMES, 'W1', 'MN') or not 1 <= visible <= 2000:
        raise ValueError('Invalid viewport demand')
    plan = db.get(ChartHistoryPlan, instrument)
    if plan is None:
        return None
    values = dict(instrument_id=instrument, timeframe=timeframe,
                  start=plan.target_start, end=min(end, plan.target_end),
                  warm_start=plan.target_start, focused=focused, expires=now + 45000)
    demand = db.get(ChartViewportDemand, ident)
    if demand is None:
        db.add(ChartViewportDemand(id=ident, **values))
    else:
        for key, value in values.items():
            setattr(demand, key, value)
    db.flush()
    return plan


def priority_regions(db, plan, now):
    # Viewing never outranks realtime work or changes the approved range.
    return [(plan.target_start, plan.target_end, 300)]


def advance_plan(db, plan, now):
    """Newest missing segment first, one bounded segment in flight per instrument."""
    from .market import stored_coverage
    from .market_data import missing_intervals
    from .storage import ImportJob

    if plan.status != 'pending':
        return False
    inst = db.scalar(select(Instrument).where(
        Instrument.id == plan.instrument_id).with_for_update())
    coverage = stored_coverage(db, inst, plan.target_start, plan.target_end)
    missing = list(missing_intervals(coverage, plan.target_start, plan.target_end))
    plan.cursor = missing[-1][1] if missing else plan.target_start
    if not missing:
        pending = db.scalar(select(ChartAggregationJob.id).where(
            ChartAggregationJob.instrument_id == inst.id,
            ChartAggregationJob.kind == "price",
            ChartAggregationJob.start < plan.target_end,
            ChartAggregationJob.end > plan.target_start).limit(1))
        if pending is None:
            plan.status = 'complete'
        return False
    # Recent repairs yield a whole cycle to the dedicated realtime executor.
    if db.scalar(select(ImportJob.id).where(ImportJob.priority == 0,
            ImportJob.status.in_(['pending', 'running'])).limit(1)):
        return False
    jobs = list(db.scalars(select(ImportJob).where(
        ImportJob.instrument_id == inst.id,
        ImportJob.status.in_(['pending', 'running', 'failed']),
        ImportJob.end > plan.target_start, ImportJob.cursor < plan.target_end)))
    # Do not go around an unfinished newer segment into older history.
    left, right = missing[-1]
    if any(j.cursor < right and j.end > left for j in jobs):
        return False
    # Ten trading hours bounds HTTP, batch writes and aggregation work. It is
    # an execution unit, never the three-screen opening threshold.
    start = max(left, right - 600 * 60000)
    db.add(ImportJob(instrument_id=inst.id, start=start, end=right, cursor=start,
        priority=300, chart_plan=True, next_at=now))
    db.flush()
    return True


def advance_pending_plans():
    from .storage import now_ms, transaction

    with transaction() as db:
        ids = list(db.scalars(select(ChartHistoryPlan.instrument_id).where(
            ChartHistoryPlan.status == 'pending').order_by(ChartHistoryPlan.updated_at)))
    queued = 0
    for ident in ids:
        if not validate_history_start(ident):
            continue
        with transaction() as db:
            plan = db.get(ChartHistoryPlan, ident)
            if plan:
                queued += int(advance_plan(db, plan, now_ms()))
    return queued


def boundary_context(inst, start):
    import hashlib

    from .config import settings

    namespace = hashlib.sha256(settings.oanda_account_id.encode()).hexdigest() if inst.source == 'oanda' else inst.source
    return dict(target_start=start, source=inst.source, symbol=inst.symbol,
                basis=inst.basis, namespace=namespace)


def record_boundary(db, inst, start, earliest, now):
    from .storage import Preference, instant

    key = 'chart_history_boundary:' + inst.id
    row = db.get(Preference, key)
    value = {**boundary_context(inst, start), 'earliest': earliest,
             'checked_at': now, 'retry_at': now + 86400000,
             'error': (f'历史起点不可达：最早可用M1为 {instant(earliest).isoformat()}；请通过维护表单明确选择可达起点。原批准范围和已发布行情保持不变。'
                       if start < earliest else None)}
    if row:
        row.value = value
    else:
        db.add(Preference(key=key, value=value))


def validate_history_start(instrument):
    """Validate legacy approvals outside the DB transaction before scheduling.

    New submissions already carry this proof. Unreachable old plans retain
    their original approval and published data, with an actionable error;
    they cannot certify pre-listing empty OANDA responses as valid history.
    """
    import httpx

    from .provider_chart import earliest_m1
    from .storage import ImportJob, Preference, now_ms, transaction

    key = 'chart_history_boundary:' + instrument
    with transaction() as db:
        plan = db.get(ChartHistoryPlan, instrument)
        if not plan or plan.status != 'pending':
            return False
        inst = db.get(Instrument, instrument)
        # Only the supported native sources can prove a first M1 here.
        if inst.source not in ('oanda', 'binance'):
            return True
        context = boundary_context(inst, plan.target_start)
        old = db.get(Preference, key)
        if old and all(old.value.get(k) == v for k, v in context.items()) and old.value.get('retry_at', 0) > now_ms():
            return not old.value.get('error')
        if db.scalar(select(ImportJob.id).where(ImportJob.priority == 0,
                ImportJob.status.in_(['pending', 'running'])).limit(1)):
            return False
        meta = dict(id=inst.id, source=inst.source, symbol=inst.symbol, basis=inst.basis)
    earliest, error = None, None
    try:
        earliest = earliest_m1(meta)
        if context['target_start'] < earliest:
            from .storage import instant
            error = f'历史起点不可达：最早可用M1为 {instant(earliest).isoformat()}；请通过维护表单明确选择可达起点。原批准范围和已发布行情保持不变。'
    except (httpx.HTTPError, TimeoutError, ValueError):
        error = '尚未确认最早可用历史，历史任务暂未推进，请稍后重试；实时维护继续运行。'
    with transaction() as db:
        inst = db.scalar(select(Instrument).where(Instrument.id == instrument).with_for_update())
        plan = db.get(ChartHistoryPlan, instrument)
        if not plan or plan.status != 'pending' or boundary_context(inst, plan.target_start) != context:
            return False
        now = now_ms()
        value = {**context, 'earliest': earliest, 'checked_at': now,
                 'retry_at': now + (86400000 if earliest is not None else 30000), 'error': error}
        old = db.get(Preference, key)
        if old:
            old.value = value
        else:
            db.add(Preference(key=key, value=value))
        if error:
            for job in db.scalars(select(ImportJob).where(ImportJob.instrument_id == instrument,
                    ImportJob.chart_plan.is_(True), ImportJob.status.in_(['pending', 'running']))):
                if earliest is not None:
                    job.status, job.error, job.lease_until = 'failed', error, None
                else:
                    job.next_at = max(job.next_at, value['retry_at'])
    return error is None


def plan_status(db, plan, now):
    from .managed_dataset import status
    from .market import stored_coverage
    from .market_data import missing_intervals
    from .storage import ImportJob, Preference

    inst = db.get(Instrument, plan.instrument_id)
    spans = stored_coverage(db, inst, plan.target_start, plan.target_end)
    total = plan.target_end - plan.target_start
    missing = sum(b-a for a,b in missing_intervals(spans, plan.target_start, plan.target_end))
    jobs = list(db.scalars(select(ImportJob).where(
        ImportJob.instrument_id == inst.id, ImportJob.chart_plan.is_(True),
        ImportJob.status.in_(['pending', 'running', 'failed']))))
    aggregation = list(db.scalars(select(ChartAggregationJob).where(
        ChartAggregationJob.instrument_id == inst.id)))
    boundary = db.get(Preference, 'chart_history_boundary:' + inst.id)
    boundary_error = boundary.value.get('error') if boundary and all(
        boundary.value.get(k) == v for k, v in boundary_context(inst, plan.target_start).items()) else None
    return dict(instrument=inst.id, status=plan.status, start=plan.target_start,
        end=plan.target_end, cursor=plan.cursor, realtime_enabled=plan.realtime_enabled,
        realtime_end=plan.realtime_end, realtime_quality=inst.quality,
        realtime_error=inst.error, covered_ms=total-missing, total_ms=total,
        priority=300, pending=sum(j.status=='pending' for j in jobs),
        running=sum(j.status=='running' for j in jobs), failed=sum(j.status=='failed' for j in jobs),
        aggregation_pending=len(aggregation),
        aggregation_failed=sum(j.error is not None for j in aggregation),
        boundary_error=boundary_error,
        download_errors=[dict(id=j.id, start=j.start, end=j.end, error=j.error,
            attempts=j.attempts, retry_at=j.next_at, status=j.status) for j in jobs if j.error],
        aggregation_errors=[dict(id=j.id, timeframe=j.timeframe, start=j.start, end=j.end,
            error=j.error, attempts=j.attempts, retry_at=j.next_at) for j in aggregation if j.error],
        periods=[status(db, inst, frame) for frame in (*sorted(FRAMES), 'W1', 'MN')])


def control_plan(db, instrument, action, now):
    from .storage import ImportJob

    if action not in ('cancel', 'resume', 'retry'):
        raise ValueError('Unknown plan action')
    db.scalar(select(Instrument).where(Instrument.id == instrument).with_for_update())
    plan = db.get(ChartHistoryPlan, instrument)
    if plan is None:
        raise ValueError('History plan not found')
    jobs = list(db.scalars(select(ImportJob).where(
        ImportJob.instrument_id == instrument, ImportJob.chart_plan.is_(True),
        ImportJob.status.in_(['pending', 'running', 'failed', 'cancelled']))))
    if action == 'cancel':
        from .storage import VolumeBackfillJob
        from .volume_jobs import control
        for volume_job in db.scalars(select(VolumeBackfillJob).where(
                VolumeBackfillJob.instrument_id == instrument,
                VolumeBackfillJob.status.in_(("pending", "running", "partial", "failed")))):
            control(db, volume_job.id, "cancel")
        plan.status = 'cancelled'
        for job in jobs:
            job.status = 'cancelled'
            job.lease_until = None
    else:
        plan.status = 'pending'
        # The planner reuses committed coverage. Clear old reservations rather
        # than revive years of legacy slices at once.
        for job in jobs:
            if job.status == 'cancelled' or action == 'retry' and job.status == 'failed':
                job.status = 'superseded'
                job.lease_until = None
        if action == 'retry':
            for job in db.scalars(select(ChartAggregationJob).where(
                    ChartAggregationJob.instrument_id == instrument,
                    ChartAggregationJob.error.is_not(None))):
                job.next_at = now
                job.error = None
                job.attempts = 0
    plan.updated_at = now
    db.flush()
    return plan
