"""Shared durable history target, separate from cancellable browser requests."""
from datetime import timedelta

from sqlalchemy import select

from .calendar_profile import closures_from
from .chart_data import bounds
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
                              gold=inst.id == "XAUUSD", closures=closures):
            remaining -= 1
        cursor = left
        if remaining == 0:
            return ms(left)
    raise ValueError("No sufficient scheduled trading history")


def update_demand(db, *, ident, instrument, timeframe, end, visible, focused, now, required=None):
    if timeframe not in FRAMES or not 1 <= visible <= 2000:
        raise ValueError("Invalid viewport demand")
    # Calendar scanning is CPU work and must happen before the writer lock.
    inst = db.get(Instrument, instrument)
    if inst is None:
        raise ValueError("Instrument must be resolved before demand registration")
    required = max(visible, required or visible)
    if required > 6000:
        raise ValueError("单次指标历史需求超过6000根，请缩小计算窗口")
    start = history_start(inst, timeframe, end, required)
    warm = history_start(inst, timeframe, end, max(required, visible * 3))
    daily = history_start(inst, "D1", end, visible * 3)
    target = min(warm, daily)
    # Serialize the brief target merge, not calendar calculation or network I/O.
    db.scalar(select(Instrument).where(Instrument.id == instrument).with_for_update())
    plan = db.get(ChartHistoryPlan, instrument)
    if plan is None:
        plan = ChartHistoryPlan(instrument_id=instrument, target_start=target,
                                target_end=end, status="pending", updated_at=now)
        db.add(plan)
    else:
        expanded = target < plan.target_start or end > plan.target_end
        plan.target_start = min(plan.target_start, target)
        plan.target_end = max(plan.target_end, end)
        if expanded and plan.status != "cancelled":
            plan.status = "pending"
        plan.updated_at = now
    demand = db.get(ChartViewportDemand, ident)
    values = dict(instrument_id=instrument, timeframe=timeframe, start=start, end=end,
                  warm_start=warm, focused=focused, expires=now + 45000)
    if demand is None:
        db.add(ChartViewportDemand(id=ident, **values))
    else:
        for key, value in values.items():
            setattr(demand, key, value)
    db.flush()
    return plan


def priority_regions(db, plan, now):
    """Closed windows retain a bounded target at lowest priority (300)."""
    active = list(db.scalars(select(ChartViewportDemand).where(
        ChartViewportDemand.instrument_id == plan.instrument_id,
        ChartViewportDemand.expires > now)))
    regions = [(d.start, d.end, 100 if d.focused else 110) for d in active]
    regions += [(d.warm_start, d.end, 130 if d.focused else 150) for d in active]
    regions.append((plan.target_start, plan.target_end, 170 if active else 300))
    return sorted(regions, key=lambda region: region[2])


def advance_plan(db, plan, now):
    """Queue at most one bounded missing segment; existing jobs share reservations.

    Only jobs owned by this plan may be demoted. Ordinary repair/manual/weekly
    jobs retain their own lifecycle. The import worker keeps the actual lease.
    """
    from .coverage import covers_interval
    from .market import stored_coverage
    from .market_data import missing_intervals
    from .storage import ImportJob

    if plan.status != "pending":
        return False
    inst = db.scalar(select(Instrument).where(
        Instrument.id == plan.instrument_id).with_for_update())
    regions = priority_regions(db, plan, now)
    coverage = stored_coverage(db, inst, plan.target_start, plan.target_end)
    jobs = list(db.scalars(select(ImportJob).where(
        ImportJob.instrument_id == inst.id,
        ImportJob.status.in_(["pending", "running", "failed"]),
        ImportJob.end > plan.target_start, ImportJob.cursor < plan.target_end)))
    for job in jobs:
        if job.chart_plan and job.status == "pending":
            job.priority = min((priority for left, right, priority in regions
                                if job.cursor < right and job.end > left), default=300)
    if covers_interval(coverage, plan.target_start, plan.target_end):
        pending_aggregation = db.scalar(select(ChartAggregationJob.id).where(
            ChartAggregationJob.instrument_id == inst.id,
            ChartAggregationJob.start < plan.target_end,
            ChartAggregationJob.end > plan.target_start).limit(1))
        if pending_aggregation is None:
            plan.status = "complete"
        return False
    reserved = coverage + [{"start": job.cursor, "end": job.end} for job in jobs]
    for left, right, priority in regions:
        missing = list(missing_intervals(reserved, left, right))
        if not missing:
            continue
        active_jobs = [job for job in jobs if job.chart_plan and
                       job.status in ("pending", "running")]
        if len(active_jobs) >= 2:
            # A newly viewed range can displace queued deep prewarm. Its
            # durable envelope remains, so the cancelled slice is planned later.
            replaceable = [job for job in active_jobs if job.status == "pending"
                           and job.priority > priority]
            if not replaceable:
                return False
            max(replaceable, key=lambda job: job.priority).status = "superseded"
        start, end = missing[-1]
        start = max(start, end - 4000 * 60000)
        db.add(ImportJob(instrument_id=inst.id, start=start, end=end, cursor=start,
                         priority=priority, chart_plan=True, next_at=now))
        db.flush()
        return True
    return False


def advance_pending_plans():
    """One scheduling pass; each plan contributes at most one download page."""
    from .storage import now_ms, transaction

    with transaction() as db:
        ids = list(db.scalars(select(ChartHistoryPlan.instrument_id).where(
            ChartHistoryPlan.status == "pending").order_by(ChartHistoryPlan.updated_at)))
    queued = 0
    for ident in ids:
        # Release each instrument lock before moving to another plan.
        with transaction() as db:
            plan = db.get(ChartHistoryPlan, ident)
            if plan:
                queued += int(advance_plan(db, plan, now_ms()))
    return queued


def plan_status(db, plan, now):
    from .market import stored_coverage
    from .market_data import missing_intervals
    from .storage import ImportJob

    inst = db.get(Instrument, plan.instrument_id)
    spans = stored_coverage(db, inst, plan.target_start, plan.target_end)
    total = plan.target_end - plan.target_start
    missing = sum(b-a for a,b in missing_intervals(spans,plan.target_start,plan.target_end))
    jobs = list(db.scalars(select(ImportJob).where(
        ImportJob.instrument_id == plan.instrument_id, ImportJob.chart_plan.is_(True),
        ImportJob.status.in_(['pending','running','failed']))))
    aggregation = list(db.scalars(select(ChartAggregationJob).where(
        ChartAggregationJob.instrument_id == plan.instrument_id,
        ChartAggregationJob.start < plan.target_end,
        ChartAggregationJob.end > plan.target_start)))
    status = 'pending' if aggregation and plan.status == 'complete' else plan.status
    return dict(instrument=plan.instrument_id, status=status,
                aggregation_pending=len(aggregation),
                aggregation_failed=sum(job.error is not None for job in aggregation),
                start=plan.target_start, end=plan.target_end,
                covered_ms=total-missing, total_ms=total,
                priority=priority_regions(db,plan,now)[0][2],
                pending=sum(job.status=='pending' for job in jobs),
                running=sum(job.status=='running' for job in jobs),
                failed=sum(job.status=='failed' for job in jobs))


def control_plan(db, instrument, action, now):
    from .storage import ImportJob

    if action not in ('cancel','resume','retry'):
        raise ValueError('Unknown plan action')
    db.scalar(select(Instrument).where(Instrument.id==instrument).with_for_update())
    plan = db.get(ChartHistoryPlan,instrument)
    if plan is None:
        raise ValueError('History plan not found')
    jobs = list(db.scalars(select(ImportJob).where(
        ImportJob.instrument_id==instrument, ImportJob.chart_plan.is_(True),
        ImportJob.status.in_(['pending','running','failed','cancelled']))))
    if action=='cancel':
        plan.status='cancelled'
        for job in jobs:
            job.status='cancelled'
            job.lease_until=None
    else:
        plan.status='pending'
        regions = priority_regions(db, plan, now)
        available = max(0, 2 - sum(job.status in ('pending', 'running') for job in jobs))
        candidates = [job for job in jobs if job.status == 'cancelled'
                      or (action == 'retry' and job.status == 'failed')]
        for job in candidates:
            job.priority = min((priority for left, right, priority in regions
                                if job.cursor < right and job.end > left), default=300)
        # Resume only a bounded batch, choosing the currently viewed range first.
        # The durable plan retains all remaining holes and requeues them later;
        # committed coverage and each old cursor remain untouched.
        candidates.sort(key=lambda job: (job.priority, -job.end, job.id))
        for index, job in enumerate(candidates):
            job.status = 'pending' if index < available else 'superseded'
            job.next_at = now
            job.error = None
            job.lease_until = None
    if action == 'retry':
        for aggregate_job in db.scalars(select(ChartAggregationJob).where(
                ChartAggregationJob.instrument_id == instrument,
                ChartAggregationJob.error.is_not(None))):
            aggregate_job.next_at = now
            aggregate_job.error = None
            aggregate_job.attempts = 0
    plan.updated_at=now
    db.flush()
    return plan
