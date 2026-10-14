"""Bounded background replay for display suffixes beyond the HTTP work budget."""

import gzip
import json

from sqlalchemy import delete, func, select, text

from .indicator_state import IndicatorState
from .source_history_store import _insert
from .storage import DisplayIndicatorTask, DisplaySnapshot, FixedIndicatorRun, now_ms, transaction, uid

PAGE_SIZE = 2000
MAX_OUTPUT_ROWS = 10000
MAX_FAILURES = 3
MAX_TASKS = 256
MAX_OUTPUT_BYTES = 64 * 1024 * 1024
MAX_STATE_BYTES = 8 * 1024 * 1024


class DisplayTaskCapacity(ValueError):
    code = 'DISPLAY_TASK_CAPACITY'

    def __init__(self):
        super().__init__('展示指标任务容量已满；等待现有任务释放后重试')


class DisplayReplayFailure(ValueError):
    code = 'DISPLAY_REPLAY_FAILED'

    def __init__(self):
        super().__init__('展示指标重算连续失败；请重试指标或重新读取行情')


class DisplayOutputLimit(ValueError):
    code = 'DISPLAY_SUFFIX_CAPACITY_EXCEEDED'

    def __init__(self):
        super().__init__('展示指标后缀超过容量；请等待待确认分钟补齐或缩小计算范围后重试')


def pack(rows):
    return gzip.compress(json.dumps(rows, separators=(',', ':'), allow_nan=False).encode(), mtime=0)


def fault_token(task):
    from .fixed_indicators import digest

    return digest([task.id, task.error, task.next_at, task.lease_token])


def request(db, run, snapshot, affected, cursor, end, checkpoint, *, retry=None):
    from .fixed_indicators import digest

    ident = digest([snapshot.id, run.id, affected, cursor, end])
    task = db.get(DisplayIndicatorTask, ident)
    if not task:
        if db.bind.dialect.name == 'postgresql':
            db.execute(text('SELECT pg_advisory_xact_lock(8675312)'))
            task = db.get(DisplayIndicatorTask, ident)
        if task:
            return request(db, run, snapshot, affected, cursor, end, checkpoint, retry=retry)
        db.execute(delete(DisplayIndicatorTask).where(DisplayIndicatorTask.snapshot_id.in_(
            select(DisplaySnapshot.id).where(DisplaySnapshot.expires_at < now_ms()))))
        count = db.scalar(select(func.count()).select_from(DisplayIndicatorTask))
        weight = db.scalar(select(func.sum(func.length(DisplayIndicatorTask.output)))) or 0
        initial_state = checkpoint or IndicatorState(run.spec).checkpoint()
        if count >= MAX_TASKS or weight >= MAX_OUTPUT_BYTES or len(json.dumps(initial_state).encode()) > MAX_STATE_BYTES:
            raise DisplayTaskCapacity()
        db.execute(_insert(db)(DisplayIndicatorTask).values(id=ident, snapshot_id=snapshot.id,
            run_id=run.id, affected=affected, cursor=cursor, end=end,
            state=initial_state, dependent=False,
            output=pack([]), status='pending', lease_until=0, next_at=0)
            .on_conflict_do_nothing(index_elements=['id']))
        task = db.get(DisplayIndicatorTask, ident)
    restarted = None
    if retry and ident in retry:
        if db.bind.dialect.name == 'postgresql':
            db.execute(text('SELECT pg_advisory_xact_lock(8675312)'))
        task = db.scalar(select(DisplayIndicatorTask).where(DisplayIndicatorTask.id == ident)
            .with_for_update().execution_options(populate_existing=True))
        # A fault token authorizes one restart of that exact terminal attempt.
        # Polling and duplicate/stale user actions cannot reset a newer fault.
        if task.status == 'error' and fault_token(task) == retry[ident]:
            restarted = {ident: retry[ident]}
            task.status, task.error, task.next_at = 'pending', None, 0
            task.lease_token, task.lease_until = None, 0
    if task.status != 'complete':
        if task.status == 'error':
            error = (DisplayOutputLimit() if task.error == 'DisplayOutputLimit' else
                DisplayTaskCapacity() if task.error == 'DisplayTaskCapacity' else DisplayReplayFailure())
            error.display_retry = {ident: fault_token(task)}
            raise error
        return {'pending': True, 'affected': affected, 'task_id': ident, 'restarted': restarted}
    return {'pending': False, 'affected': affected, 'task_id': ident,
            'rows': json.loads(gzip.decompress(task.output)), 'display': task.presentation}


def tick():
    from . import fixed_indicators as fixed
    from .composite_chart import SPAN
    from .composite_series import read_window
    from .storage import CompositeRevision

    stamp = now_ms()
    with transaction() as db:
        task = db.scalar(select(DisplayIndicatorTask).join(DisplaySnapshot).where(
            DisplayIndicatorTask.status == 'pending', DisplayIndicatorTask.next_at <= stamp,
            DisplayIndicatorTask.lease_until <= stamp, DisplaySnapshot.expires_at > stamp)
            .order_by(DisplaySnapshot.expires_at.desc(), DisplayIndicatorTask.id)
            .with_for_update(of=DisplayIndicatorTask, skip_locked=True).limit(1))
        if not task:
            return False
        task.lease_token, task.lease_until = uid(), stamp + 60000
        ident, token, cursor = task.id, task.lease_token, task.cursor
    try:
        with transaction() as db:
            task = db.get(DisplayIndicatorTask, ident)
            if not task:
                return True
            snapshot = db.get(DisplaySnapshot, task.snapshot_id)
            run = db.get(FixedIndicatorRun, task.run_id)
            revision = db.get(CompositeRevision, run.revision_id)
            _, _, phase, profiles = fixed._context(db, run)
            if profiles:
                left, _, profile = profiles[-1]
                profiles[-1] = (left, task.end, profile)
            engine = IndicatorState(run.spec, task.state)
            end = min(task.end, cursor + min(28 * 86400000, SPAN[run.timeframe] * PAGE_SIZE))
            # Whole period boundaries preserve D/W/M phase, including DST.
            end = min(task.end, fixed.period(end - 1, run.timeframe, phase)[1])
            if end - cursor > 32 * 86400000:
                end = min(task.end, fixed.period(cursor, run.timeframe, phase)[1])
            inputs = read_window(db, revision.composite_id, run.timeframe, cursor, end,
                revision_id=revision.id, provisional=True, now=snapshot.content['now'],
                display_snapshot=snapshot)['bars']
            rows, dependent = json.loads(gzip.decompress(task.output)), task.dependent
            for bar in inputs:
                row = {**bar, 'gap_before': fixed.gap_before(engine.state.get('last_end'), bar['start'], phase, profiles)}
                if row['gap_before']:
                    dependent = False
                dependent |= not bar['complete']
                if run.spec['name'] == 'SWING_SR_V1':
                    from .series_access import fixed_label

                    row['chart_time'] = fixed_label(row, run.timeframe, phase)
                values = engine.display_step(row, provisional_dependency=dependent)
                if bar['start'] >= task.affected:
                    rows.append({'start': bar['start'], 'end': bar['end'], 'values': values,
                        'provisional': dependent, 'dependency_origin': engine.state.get('origin'),
                        'seam_dependency': engine.state.get('seam', False), 'initialized': engine.initialized(values),
                        **({'break_before': True} if row['gap_before'] else {})})
            if len(rows) > MAX_OUTPUT_ROWS:
                raise DisplayOutputLimit()
            state, output, display = engine.checkpoint(), pack(rows), getattr(engine, 'last_presentation', None)
            if len(json.dumps(state).encode()) > MAX_STATE_BYTES:
                raise DisplayTaskCapacity()
            if display:
                display = display | {'history_complete': run.status == 'complete', 'history_revision': run.id}
        with transaction() as db:
            if db.bind.dialect.name == 'postgresql':
                # Same order as request/expired-task cleanup: budget lock,
                # then task row. Reversing it can deadlock at lease expiry.
                db.execute(text('SELECT pg_advisory_xact_lock(8675312)'))
            task = db.scalar(select(DisplayIndicatorTask).where(DisplayIndicatorTask.id == ident).with_for_update())
            if not task or task.lease_token != token or task.cursor != cursor or task.lease_until <= now_ms():
                return True
            weight = db.scalar(select(func.sum(func.length(DisplayIndicatorTask.output)))) or 0
            if weight - len(task.output) + len(output) > MAX_OUTPUT_BYTES:
                raise DisplayTaskCapacity()
            task.state, task.output, task.presentation, task.dependent = state, output, display, dependent
            task.cursor, task.status = end, 'complete' if end >= task.end else 'pending'
            task.lease_token, task.lease_until, task.error = None, 0, None
    except Exception as error:
        with transaction() as db:
            task = db.scalar(select(DisplayIndicatorTask).where(DisplayIndicatorTask.id == ident).with_for_update())
            if task and task.lease_token == token:
                previous = (task.error or '').rsplit(':', 1)[-1]
                failures = (int(previous) if previous.isdigit() else 0) + 1
                task.error = type(error).__name__[:48] + ':' + str(failures)
                task.next_at = now_ms() + min(30000, 1000 * 2 ** (failures - 1))
                if isinstance(error, (DisplayOutputLimit, DisplayTaskCapacity)):
                    task.error, task.status = type(error).__name__, 'error'
                elif isinstance(error, (ValueError, TypeError, KeyError)) or failures >= MAX_FAILURES:
                    task.status = 'error'
                task.lease_token, task.lease_until = (uid() if task.status == 'error' else None), 0
    return True
