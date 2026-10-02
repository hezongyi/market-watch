"""Fenced volume-only history work. Network I/O never holds a transaction."""
from decimal import Decimal

from sqlalchemy import delete, func, or_, select

from .bar_batch import write_bars
from .domain import Candle
from .storage import (
    Audit,
    Bar,
    ChartAggregationJob,
    ChartHistoryPlan,
    ChartPublicationJob,
    ChartPublishedBar,
    ImportJob,
    Instrument,
    Preference,
    VolumeBackfillJob,
    VolumeBackfillSegment,
    instant,
    now_ms,
    transaction,
    uid,
)
from .volume import quantity

UNRESOLVED = ('missing', 'conflict', 'unreachable', 'failed', 'retry')


def context(inst):
    return dict(source=inst.source, symbol=inst.symbol, basis=inst.basis,
                calendar=inst.calendar, calendar_profile=inst.calendar_profile)


def authorized(job, inst):
    return all(getattr(job, k) == v for k, v in context(inst).items())


def create(db, instrument, *, start=None, end=None, automatic=False, now=None):
    now = now if now is not None else now_ms()
    inst = db.scalar(select(Instrument).where(Instrument.id == instrument).with_for_update())
    if not inst or inst.source not in ('oanda', 'binance'):
        raise ValueError('该来源尚无可确认的量口径')
    plan = db.get(ChartHistoryPlan, instrument)
    if automatic and (not plan or plan.status == 'cancelled' or not plan.realtime_enabled):
        return None
    if plan:
        start = plan.target_start if start is None else start
        if start < plan.target_start:
            raise ValueError('不能扩大已批准历史范围')
    elif start is None or end is None:
        raise ValueError('无维护计划时必须明确选择已有 M1 范围')
    first, last = db.execute(select(func.min(Bar.start), func.max(Bar.end)).where(
        Bar.instrument_id == instrument, Bar.timeframe == 'M1', Bar.complete.is_(True))).one()
    if first is None:
        raise ValueError('没有可补量的已收盘 M1')
    if not plan and (start < first or end > last):
        raise ValueError('不能超出已有 M1 范围')
    left, right = max(start, first), min(end if end is not None else last, last, (now-5000)//60000*60000)
    if left >= right or left % 60000 or right % 60000:
        raise ValueError('无有效的已收盘分钟范围')
    # A single active authorization per instrument avoids overlapping requests.
    matches = list(db.scalars(select(VolumeBackfillJob).where(
        VolumeBackfillJob.instrument_id == instrument,
        VolumeBackfillJob.status.in_(("pending", "running", "failed", "partial")),
        VolumeBackfillJob.start < right, VolumeBackfillJob.end > left)
        .order_by(VolumeBackfillJob.created_at, VolumeBackfillJob.id).with_for_update()))
    if matches:
        if any(not authorized(j, inst) for j in matches):
            raise ValueError("旧量任务口径变化，须取消后重新建立任务")
        existing = matches[0]
        if left < existing.start or right > existing.end or len(matches) > 1:
            old_end = existing.end
            existing.generation += 1
            existing.lease_token, existing.lease_until = None, 0
            existing.start = min(left, *(j.start for j in matches))
            existing.end = max(right, *(j.end for j in matches))
            existing.cursor = max(j.cursor for j in matches)
            existing.status, existing.next_at = "pending", 0
            for start_at in range(max(old_end, existing.cursor), existing.end, 600*60000):
                db.add(VolumeBackfillSegment(job_id=existing.id, start=start_at,
                    end=min(existing.end, start_at+600*60000), status="retry"))
            for other in matches[1:]:
                for segment in db.scalars(select(VolumeBackfillSegment).where(
                        VolumeBackfillSegment.job_id == other.id,
                        VolumeBackfillSegment.status.in_(UNRESOLVED))):
                    db.add(VolumeBackfillSegment(job_id=existing.id, start=segment.start,
                        end=segment.end, status="retry", detail=segment.detail))
                other.generation += 1
                other.status, other.lease_token, other.lease_until = "cancelled", None, 0
            db.add(Audit(kind="volume_backfill_extend", details=dict(job=existing.id,
                start=existing.start, end=existing.end, automatic=automatic,
                merged=[j.id for j in matches[1:]])))
        return existing
    job = VolumeBackfillJob(instrument_id=instrument, **context(inst), start=left, end=right,
                            cursor=right, status='pending')
    db.add(job)
    db.flush()
    db.add(Audit(kind='volume_backfill_start', details=dict(job=job.id, instrument=instrument,
        start=left, end=right, automatic=automatic, **context(inst))))
    return job


def locked(db, ident):
    instrument = db.scalar(select(VolumeBackfillJob.instrument_id).where(VolumeBackfillJob.id == ident))
    if instrument is None:
        raise ValueError('量任务不存在')
    inst = db.scalar(select(Instrument).where(Instrument.id == instrument).with_for_update())
    job = db.scalar(select(VolumeBackfillJob).where(VolumeBackfillJob.id == ident)
                    .with_for_update().execution_options(populate_existing=True))
    return inst, job


def control(db, ident, action):
    if action not in ('cancel', 'resume', 'retry'):
        raise ValueError('未知量任务操作')
    inst, job = locked(db, ident)
    if action != 'cancel' and not authorized(job, inst):
        raise ValueError('来源或价格口径变化，旧量任务不能恢复')
    if action != "cancel" and db.scalar(select(VolumeBackfillJob.id).where(
            VolumeBackfillJob.id != job.id, VolumeBackfillJob.instrument_id == inst.id,
            VolumeBackfillJob.status.in_(("pending", "running", "partial", "failed")),
            VolumeBackfillJob.start < job.end, VolumeBackfillJob.end > job.start).limit(1)):
        raise ValueError("已有重叠活动量任务，请完成或取消后恢复")
    job.generation += 1
    job.lease_token, job.lease_until = None, 0
    job.error, job.attempts, job.next_at = None, 0, 0
    job.status = 'cancelled' if action == 'cancel' else 'pending'
    if action != 'cancel':
        for segment in db.scalars(select(VolumeBackfillSegment).where(
                VolumeBackfillSegment.job_id == ident, VolumeBackfillSegment.status.in_(UNRESOLVED))):
            segment.status = 'retry'
    db.add(Audit(kind='volume_backfill_'+action, details=dict(job=ident, generation=job.generation)))
    db.flush()
    return job


def describe(db, job):
    result = {k: getattr(job, k) for k in ('id', 'instrument_id', 'source', 'basis', 'calendar',
        'start', 'end', 'cursor', 'status', 'generation', 'attempts', 'next_at', 'error')}
    result['unresolved'] = db.scalar(select(func.count()).select_from(VolumeBackfillSegment).where(
        VolumeBackfillSegment.job_id == job.id, VolumeBackfillSegment.status.in_(UNRESOLVED)))
    return result


def finish(db, job):
    if job.cursor > job.start:
        return False
    retry = db.scalar(select(VolumeBackfillSegment.id).where(
        VolumeBackfillSegment.job_id == job.id, VolumeBackfillSegment.status == "retry").limit(1))
    if retry:
        return False
    pending = db.scalar(select(ChartAggregationJob.id).where(
        ChartAggregationJob.instrument_id == job.instrument_id,
        ChartAggregationJob.start < job.end, ChartAggregationJob.end > job.start).limit(1))
    publication = db.scalar(select(ChartPublicationJob.start).where(
        ChartPublicationJob.instrument_id == job.instrument_id,
        ChartPublicationJob.start < job.end, ChartPublicationJob.end > job.start).limit(1))
    if pending or publication:
        job.next_at = now_ms()+1000
        return True
    missing = db.scalar(select(Bar.id).where(Bar.instrument_id == job.instrument_id,
        Bar.timeframe == 'M1', Bar.complete.is_(True), Bar.start >= job.start, Bar.end <= job.end,
        or_(Bar.volume.is_(None), Bar.volume_complete.is_(False))).limit(1))
    unresolved = describe(db, job)['unresolved']
    derived = db.scalar(select(Bar.id).where(Bar.instrument_id == job.instrument_id,
        Bar.timeframe != 'M1', Bar.complete.is_(True), Bar.start >= job.start, Bar.end <= job.end,
        or_(Bar.volume.is_(None), Bar.volume_complete.is_(False))).limit(1))
    unpublished = db.scalar(select(Bar.id).where(Bar.instrument_id == job.instrument_id,
        Bar.complete.is_(True), Bar.start >= job.start, Bar.end <= job.end,
        ~select(ChartPublishedBar.start).where(
            ChartPublishedBar.instrument_id == Bar.instrument_id,
            ChartPublishedBar.timeframe == Bar.timeframe,
            ChartPublishedBar.start == Bar.start,
            ChartPublishedBar.payload["volume_complete"].as_boolean().is_(True)).exists()).limit(1))
    job.status = 'partial' if missing or unresolved or derived or unpublished else 'complete'
    job.error = ("已有 M1 已补量，但部分价格尚未形成已确认量的发布快照；未创建维护计划"
        if unpublished and not missing and not unresolved and not derived else
        '仍有缺量、价格冲突或未确认派生量，详见片段') if job.status == 'partial' else None
    return True


def segments(db, job, rows, outcomes, left, right):
    # Coalesce adjacent outcomes; never store an unbounded JSON list of minutes.
    groups = []
    for row in rows:
        status = outcomes.get(row.start, 'missing')
        if groups and groups[-1][2] == status and groups[-1][1] == row.start:
            groups[-1] = (groups[-1][0], row.end, status)
        else:
            groups.append((row.start, row.end, status))
    if not groups:
        groups = [(left, right, 'no_bar')]
    for start, end, status in groups:
        db.add(VolumeBackfillSegment(job_id=job.id, start=start, end=end, status=status))


def once(fetcher=None):
    from .chart_aggregation import enqueue_aggregation
    from .market import fetch_source
    from .provider_cache import interactive_busy

    with transaction() as db:
        now = now_ms()
        if db.scalar(select(ImportJob.id).where(ImportJob.priority == 0,
                ImportJob.status.in_(('pending', 'running'))).limit(1)):
            return False
        if db.scalar(select(func.count()).select_from(ChartAggregationJob).where(
                ChartAggregationJob.error.is_(None))) >= 60:
            return False
        candidate = db.scalar(select(VolumeBackfillJob).where(
            VolumeBackfillJob.next_at <= now,
            or_(VolumeBackfillJob.status == 'pending',
                (VolumeBackfillJob.status == 'running') & (VolumeBackfillJob.lease_until <= now)))
            .order_by(VolumeBackfillJob.end.desc(), VolumeBackfillJob.created_at).limit(1))
        if candidate is None:
            return False
        inst, job = locked(db, candidate.id)
        if job.status not in ('pending', 'running') or job.lease_until > now:
            return False
        if not authorized(job, inst):
            job.status, job.error = 'failed', '来源或价格口径变化，任务已停止'
            return True
        cooldown = db.get(Preference, 'market_backoff:'+job.source)
        if cooldown and cooldown.value.get('until', 0) > now:
            job.next_at = cooldown.value['until']
            return False
        if interactive_busy(job.source) or db.scalar(select(func.count()).select_from(ChartAggregationJob)
                .where(ChartAggregationJob.instrument_id == job.instrument_id)) >= 60:
            job.next_at = now+1000
            return False
        retry = db.scalar(select(VolumeBackfillSegment).where(VolumeBackfillSegment.job_id == job.id,
            VolumeBackfillSegment.status == 'retry').order_by(VolumeBackfillSegment.start.desc()).limit(1))
        if retry:
            right, retry_id = retry.end, retry.id
            left = max(retry.start, right-600*60000)
            retry_start = retry.start
        else:
            if finish(db, job):
                return True
            right, left, retry_id = job.cursor, max(job.start, job.cursor-600*60000), None
        job.generation += 1
        job.status, job.lease_token, job.lease_until = 'running', uid(), now+120000
        ident, token, generation, cursor, observation = job.id, job.lease_token, job.generation, job.cursor, now
        source, symbol = job.source, job.symbol
    try:
        payload = (fetcher or fetch_source)(source, symbol, instant(left).isoformat(), instant(right).isoformat())
        with transaction() as db:
            inst, job = locked(db, ident)
            if not (job.status == 'running' and job.generation == generation and job.lease_token == token
                    and job.lease_until > now_ms() and job.cursor == cursor and authorized(job, inst)
                    and job.start <= left < right <= job.end):
                return True
            if (payload.get('source') != job.source or payload.get('basis') != job.basis
                    or payload.get('instrument', symbol) != symbol):
                raise ValueError('Volume source, symbol or basis mismatch')
            rows = list(db.scalars(select(Bar).where(Bar.instrument_id == inst.id,
                Bar.timeframe == 'M1', Bar.complete.is_(True), Bar.start >= left, Bar.end <= right)
                .order_by(Bar.start)))
            incoming = {int(r['timestamp']): r for r in payload['rows'] if left <= int(r['timestamp']) < right}
            outcomes, candles = {}, []
            for row in rows:
                raw = incoming.get(row.start)
                if not raw:
                    outcomes[row.start] = 'resolved' if row.volume_complete else 'unreachable'
                    continue
                c = Candle(instant(row.start), instant(row.end),
                    *(Decimal(str(raw[k])) for k in ('open', 'high', 'low', 'close')),
                    complete=raw.get('complete', True),
                    volume=quantity(raw.get('volume'), tick=source == 'oanda'), volume_supplied='volume' in raw)
                if any(getattr(row, k) != getattr(c, k) for k in ('open', 'high', 'low', 'close', 'complete')):
                    outcomes[row.start] = 'conflict'
                    continue
                if c.volume is None:
                    outcomes[row.start] = 'resolved' if row.volume_complete else 'missing'
                    continue
                candles.append(c)
                outcomes[row.start] = 'resolved'
            changes = write_bars(db, inst.id, 'M1', candles, observed_at=observation, volume_only=True)
            aggregate_starts = changes.volume | ({r.start for r in rows if r.volume_complete} if retry_id else set())
            if aggregate_starts:
                enqueue_aggregation(db, inst.id, min(aggregate_starts), max(aggregate_starts)+60000,
                                    observation, kind='volume')
            # Read merged state: a late response must not claim it supplied a missing value.
            for row in rows:
                if outcomes.get(row.start) == 'resolved' and not row.volume_complete:
                    outcomes[row.start] = 'missing'
            if retry_id:
                db.execute(delete(VolumeBackfillSegment).where(VolumeBackfillSegment.id == retry_id))
                if retry_start < left:
                    db.add(VolumeBackfillSegment(job_id=job.id, start=retry_start, end=left, status="retry"))
            segments(db, job, rows, outcomes, left, right)
            if not retry_id or right == job.cursor:
                job.cursor = left
            job.status, job.lease_token, job.lease_until = 'pending', None, 0
            job.error, job.attempts, job.next_at = None, 0, now_ms()+200
            finish(db, job)
    except Exception as exc:
        with transaction() as db:
            _, job = locked(db, ident)
            if job.generation == generation and job.lease_token == token and job.status == 'running':
                job.attempts += 1
                job.status = 'failed' if job.attempts >= 5 else 'pending'
                job.error = type(exc).__name__  # URLs/account paths are not logged.
                job.next_at = now_ms()+min(300000, 1000*2**job.attempts)
                job.lease_token, job.lease_until = None, 0
                if job.status == 'failed':
                    db.add(VolumeBackfillSegment(job_id=ident, start=left, end=right,
                                                status='failed', detail=job.error))
    return True
