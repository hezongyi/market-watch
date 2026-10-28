"""Persisted switch runs; only a durable succeeded row unlocks the 30-day cleanup.

The record is the single source of truth for the switch state machine and for
the cleanup permission. Callers pass a scheduled run in, move it forward with
set_state, and record the shadow report and the activation payload; cleanups
claim and release their batch on the same row.
"""

from datetime import UTC, datetime

from sqlalchemy import select

from .storage import MarketSwitchRun, now_ms, transaction, uid

UNLOCKED = "succeeded"
STATES = ("preparing", "shadow_ready", "activating", UNLOCKED, "failed", "partial")
TERMINAL = frozenset({UNLOCKED, "failed", "partial"})
FORWARD = {
    "preparing": frozenset({"shadow_ready", "failed"}),
    "shadow_ready": frozenset({"activating", "failed"}),
    "activating": frozenset({UNLOCKED, "partial", "failed"}),
}
BATCH_OUTCOMES = ("completed", "interrupted")


def _ms(value):
    """Accept the repository's millisecond instants, or a UTC datetime."""
    if value is None:
        raise ValueError("scheduled_for 必填")
    if isinstance(value, datetime):
        value = value if value.tzinfo else value.replace(tzinfo=UTC)
        return int(value.astimezone(UTC).timestamp() * 1000)
    return int(value)


def _match(column, value):
    return column.is_(None) if value is None else column == value


def _row(db, run_id):
    row = db.get(MarketSwitchRun, run_id)
    if row is None:
        raise ValueError("切换运行不存在：" + str(run_id))
    return row


def _record(row):
    return {
        "id": row.id,
        "kind": row.kind,
        "composite_id": row.composite_id,
        "previous_revision_id": row.previous_revision_id,
        "target_revision_id": row.target_revision_id,
        "state": row.state,
        "attempts": row.attempts,
        "phase": row.phase,
        "scheduled_for": row.scheduled_for,
        "started_at": row.started_at,
        "finished_at": row.finished_at,
        "error_summary": row.error_summary,
        "shadow_report": row.shadow_report,
        "activation": row.activation,
        "retention": dict(row.retention or {}),
        "created_at": row.created_at,
        "unlocked": row.state == UNLOCKED,
    }


def _advance(row, state, now, *, phase=None, error_summary=None):
    if state != row.state:
        if state not in FORWARD.get(row.state, ()):
            raise ValueError(f"非法状态迁移：{row.state} -> {state}")
        row.state = state
        if row.started_at is None:
            row.started_at = now
        if state in TERMINAL:
            row.finished_at = now
    if phase is not None:
        row.phase = phase
    if error_summary is not None:
        row.error_summary = error_summary


def start(kind, *, composite_id=None, previous_revision_id=None, target_revision_id=None,
          scheduled_for):
    """Reuse the row already scheduled for this kind, composite and instant."""
    when = _ms(scheduled_for)
    with transaction() as db:
        row = db.scalar(select(MarketSwitchRun).where(
            MarketSwitchRun.kind == kind,
            _match(MarketSwitchRun.composite_id, composite_id),
            MarketSwitchRun.scheduled_for == when,
        ).order_by(MarketSwitchRun.created_at).limit(1))
        if row is not None:
            return _record(row)
        row = MarketSwitchRun(kind=kind, composite_id=composite_id,
                              previous_revision_id=previous_revision_id,
                              target_revision_id=target_revision_id,
                              scheduled_for=when, state="preparing")
        db.add(row)
        db.flush()
        return _record(row)


def get(run_id):
    with transaction() as db:
        row = db.get(MarketSwitchRun, run_id)
        return _record(row) if row is not None else None


def set_state(run_id, state, *, phase=None, error_summary=None):
    """Forward-only: preparing -> shadow_ready -> activating -> succeeded."""
    if state not in STATES:
        raise ValueError("未知的切换状态：" + str(state))
    with transaction() as db:
        row = _row(db, run_id)
        _advance(row, state, now_ms(), phase=phase, error_summary=error_summary)
        return _record(row)


def retry(run_id, *, phase=None):
    """Re-run a failed or partial run in place; the recorded evidence survives."""
    with transaction() as db:
        row = _row(db, run_id)
        if row.state not in ("failed", "partial"):
            raise ValueError("只有 failed/partial 的切换运行可以重试")
        row.state = "preparing"
        row.attempts = (row.attempts or 0) + 1
        row.finished_at = None
        if phase is not None:
            row.phase = phase
        return _record(row)


def record_shadow(run_id, report):
    with transaction() as db:
        row = _row(db, run_id)
        row.shadow_report = report
        if row.state == "preparing":
            _advance(row, "shadow_ready", now_ms())
        return _record(row)


def record_activation(run_id, activation):
    with transaction() as db:
        row = _row(db, run_id)
        row.activation = activation
        if row.state == "shadow_ready":
            _advance(row, "activating", now_ms())
        return _record(row)


def record_target(run_id, target_revision_id, *, previous_revision_id=None):
    """Bind the target revision while the run has not started switching."""
    with transaction() as db:
        row = _row(db, run_id)
        if row.state not in ("preparing", "shadow_ready"):
            raise ValueError(f"{row.state} 的切换运行不能修改目标修订")
        row.target_revision_id = target_revision_id
        if previous_revision_id is not None:
            row.previous_revision_id = previous_revision_id
        return _record(row)


def unlocked_runs(limit=20):
    with transaction() as db:
        rows = db.scalars(select(MarketSwitchRun).where(
            MarketSwitchRun.state == UNLOCKED,
        ).order_by(MarketSwitchRun.finished_at, MarketSwitchRun.id).limit(limit))
        return [_record(row) for row in rows]


def claim_retention(run_id, *, dry_run):
    """Claim the cleanup batch of a succeeded run; a retry keeps the same batch."""
    with transaction() as db:
        row = _row(db, run_id)
        if row.state != UNLOCKED:
            raise ValueError("只有 succeeded 的切换运行可以解锁清理")
        segment = dict(row.retention or {})
        same_pass = segment.get("batch_id") and segment.get("dry_run") == bool(dry_run)
        if not same_pass:
            segment = {"batch_id": uid(), "state": "running", "dry_run": bool(dry_run),
                       "claimed_at": now_ms(), "released_at": None, "attempts": 1,
                       "stats": {}}
        elif segment["state"] == "interrupted":
            segment.update(state="running", claimed_at=now_ms(),
                           attempts=segment.get("attempts", 0) + 1)
        row.retention = segment
        return _record(row)


def release_retention(run_id, *, outcome, stats):
    """Write the batch result and its counts; a released batch can be resumed."""
    if outcome not in BATCH_OUTCOMES:
        raise ValueError("未知的清理结果：" + str(outcome))
    with transaction() as db:
        row = _row(db, run_id)
        segment = dict(row.retention or {})
        if not segment.get("batch_id"):
            raise ValueError("该切换运行没有清理批次")
        if segment["state"] != "completed":
            segment.update(state=outcome, released_at=now_ms(),
                           stats={**segment.get("stats", {}), **stats})
        row.retention = segment
        return _record(row)
