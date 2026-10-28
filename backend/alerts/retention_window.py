"""A13a/A13b/A13c: bounded 30-day live-minute cleanup behind a persisted switch run.

The window is measured on the UTC minute a row belongs to, so a row is a
candidate only when its start is strictly earlier than the lower bound and the
boundary minute itself survives. Only a persisted succeeded switch run unlocks
deletion; that row also carries the idempotent batch identity, so an
interrupted pass resumes on the same batch instead of counting rows twice.
Real foreign keys decide the deletion order, and a recorded restore drill gates
the first real deletion.
"""

import hashlib
import json
from pathlib import Path
from uuid import uuid4

from sqlalchemy import and_, delete, exists, func, inspect, or_, select, text

from . import backup, switch_runs
from .storage import (
    ChartAlert,
    ChartAlertVersion,
    CompositeAggregateTask,
    CompositeInputEvent,
    CompositeMinute,
    CompositeMinuteInput,
    CompositePreparation,
    CompositeRevision,
    MarketComposite,
    MarketSwitchRun,
    Preference,
    SourceMinute,
    SourceMinuteRevision,
    now_ms,
    transaction,
)

WINDOW_HOURS = 30 * 24
WINDOW_MS = WINDOW_HOURS * 3600 * 1000
DEFAULT_LIMIT = 20000
DEFAULT_CHUNK = 1000
DEFAULT_BUDGET_MS = 20000
MAX_IN_LIST = 500
MAX_DETAIL = 50
RESTORE_KEY = "retention:restore_drill"

# Real foreign keys force this order: complete minutes and their input rows
# reference the source revisions, and the source head row references its
# revision, so the composite rows and the head row leave before the revision.
DELETION_ORDER = (
    "market_composite_minute_inputs",
    "market_composite_minutes",
    "market_composite_input_events",
    "market_source_minutes",
    "market_source_minute_revisions",
)

# Estimates for the dry-run byte report: source revision payloads are measured,
# dependent rows carry a fixed cost so no full table scan is needed.
SOURCE_MINUTE_BYTES = 48
COMPOSITE_MINUTE_BYTES = 96
COMPOSITE_INPUT_BYTES = 72
COMPOSITE_EVENT_BYTES = 160


def lower_bound(now=None):
    """Rows strictly earlier than this UTC instant leave the 30-day window."""
    return (now_ms() if now is None else int(now)) - WINDOW_MS


def _chunks(values, size=MAX_IN_LIST):
    value = list(values)
    for index in range(0, len(value), size):
        yield value[index:index + size]


def _zero_deleted():
    return {name: 0 for name in DELETION_ORDER}


def _run_summary(run):
    return {
        "id": run["id"],
        "kind": run["kind"],
        "composite_id": run["composite_id"],
        "state": run["state"],
        "unlocked": run["unlocked"],
        "finished_at": run["finished_at"],
        "batch": dict(run.get("retention") or {}),
    }


def _batch_summary(run):
    segment = dict(run.get("retention") or {})
    return {
        "id": segment.get("batch_id"),
        "state": segment.get("state"),
        "dry_run": segment.get("dry_run"),
        "attempts": segment.get("attempts"),
        "stats": dict(segment.get("stats") or {}),
    }


def _protected_revisions(db, now):
    """Composite revisions whose rows must survive, mapped to skip reasons."""
    reasons = {}

    def mark(value, reason):
        if value:
            reasons.setdefault(value, set()).add(reason)

    active = {revision for (revision,) in db.execute(
        select(MarketComposite.active_revision_id)) if revision}
    for revision in active:
        mark(revision, "active_composite_revision")
    prepared = set()
    for revision_id, status, error, lease_until in db.execute(select(
            CompositePreparation.revision_id, CompositePreparation.status,
            CompositePreparation.error, CompositePreparation.lease_until)):
        prepared.add(revision_id)
        if status != "queried" or error:
            mark(revision_id, "incomplete_preparation")
        elif lease_until > now:
            mark(revision_id, "leased_task")
    for revision_id, applied, lease_until, input_revision in db.execute(select(
            CompositeAggregateTask.revision_id, CompositeAggregateTask.applied_input_revision,
            CompositeAggregateTask.lease_until, CompositePreparation.input_revision).join(
                CompositePreparation,
                CompositePreparation.revision_id == CompositeAggregateTask.revision_id)):
        if lease_until > now:
            mark(revision_id, "leased_task")
        elif applied < input_revision:
            mark(revision_id, "pending_task")
    # A revision without a preparation row has unknown progress: keep its rows.
    for (revision_id,) in db.execute(select(CompositeRevision.id)):
        if revision_id not in prepared:
            mark(revision_id, "incomplete_preparation")
    rows = db.execute(select(ChartAlert.status, ChartAlertVersion.market_identity).join(
        ChartAlertVersion, and_(ChartAlertVersion.alert_id == ChartAlert.id,
                                ChartAlertVersion.version == ChartAlert.version)).where(
            ChartAlert.status != "archived"))
    for status, identity in rows:
        revision_id = (identity or {}).get("composite_revision_id")
        if not revision_id:
            continue
        if status == "active" and revision_id not in active:
            mark(revision_id, "active_alert_old_revision")
        else:
            mark(revision_id, "alert_bound_revision")
    return {revision: frozenset(value) for revision, value in reasons.items()}


def _candidate_minutes(db, lower, limit, deadline, skip=()):
    """Bounded keyset selection of source head rows older than the bound."""
    output, cursor = [], None
    while len(output) < limit and now_ms() <= deadline:
        size = min(DEFAULT_CHUNK, limit - len(output))
        query = select(SourceMinute.source_id, SourceMinute.start,
                       SourceMinute.revision_id).where(SourceMinute.start < lower)
        if cursor:
            query = query.where(or_(
                SourceMinute.start > cursor[0],
                and_(SourceMinute.start == cursor[0],
                     SourceMinute.source_id > cursor[1])))
        rows = db.execute(query.order_by(SourceMinute.start, SourceMinute.source_id)
                          .limit(size)).all()
        if not rows:
            break
        output.extend({"source_id": row[0], "start": row[1], "revision_id": row[2], "head": True}
                      for row in rows if (row[0], row[1]) not in skip)
        cursor = (rows[-1][1], rows[-1][0])
    return output


def _candidate_orphans(db, lower, limit, deadline, skip=()):
    """Superseded price revisions whose source head row points at a newer one."""
    output, cursor = [], None
    head_pointer = exists().where(SourceMinute.revision_id == SourceMinuteRevision.id)
    while len(output) < limit and now_ms() <= deadline:
        size = min(DEFAULT_CHUNK, limit - len(output))
        query = select(SourceMinuteRevision.id, SourceMinuteRevision.source_id,
                       SourceMinuteRevision.start).where(
            SourceMinuteRevision.start < lower, ~head_pointer)
        if cursor:
            query = query.where(or_(
                SourceMinuteRevision.start > cursor[0],
                and_(SourceMinuteRevision.start == cursor[0],
                     SourceMinuteRevision.id > cursor[1])))
        rows = db.execute(query.order_by(SourceMinuteRevision.start,
                                         SourceMinuteRevision.id).limit(size)).all()
        if not rows:
            break
        output.extend({"source_id": row[1], "start": row[2], "revision_id": row[0], "head": False}
                      for row in rows if row[0] not in skip)
        cursor = (rows[-1][2], rows[-1][0])
    return output


def _plan(db, *, lower, limit, now, deadline, skip_minutes=(), skip_revisions=()):
    """Select at most one batch of candidate minutes and classify every reference."""
    candidates = _candidate_minutes(db, lower, limit, deadline, skip_minutes)
    candidates += _candidate_orphans(db, lower, max(0, limit - len(candidates)), deadline,
                                     skip_revisions)
    revisions = list(dict.fromkeys(candidate["revision_id"] for candidate in candidates))
    payload, references = {}, {}
    minute_rows, input_rows = {}, {}
    for chunk in _chunks(revisions):
        for revision_id, data in db.execute(select(
                SourceMinuteRevision.id, SourceMinuteRevision.data).where(
                    SourceMinuteRevision.id.in_(chunk))):
            payload[revision_id] = len(json.dumps(data, ensure_ascii=False, default=str).encode())
        for source_revision_id, count in db.execute(select(
                CompositeMinute.source_revision_id, func.count()).where(
                    CompositeMinute.source_revision_id.in_(chunk)).group_by(
                        CompositeMinute.source_revision_id)):
            minute_rows[source_revision_id] = count
        for source_revision_id, count in db.execute(select(
                CompositeMinuteInput.source_revision_id, func.count()).where(
                    CompositeMinuteInput.source_revision_id.in_(chunk)).group_by(
                        CompositeMinuteInput.source_revision_id)):
            input_rows[source_revision_id] = count
        for source_revision_id, revision_id in db.execute(select(
                CompositeMinute.source_revision_id, CompositeMinute.revision_id).where(
                    CompositeMinute.source_revision_id.in_(chunk))):
            references.setdefault(source_revision_id, set()).add(revision_id)
        for source_revision_id, revision_id in db.execute(select(
                CompositeMinuteInput.source_revision_id, CompositeMinuteInput.revision_id).where(
                    CompositeMinuteInput.source_revision_id.in_(chunk))):
            references.setdefault(source_revision_id, set()).add(revision_id)
    protected = _protected_revisions(db, now)
    deletable, blocked = [], {}
    for candidate in candidates:
        reasons = set()
        for revision_id in references.get(candidate["revision_id"], ()):
            reasons |= protected.get(revision_id, frozenset())
        if reasons:
            blocked[candidate["revision_id"]] = sorted(reasons)
        else:
            deletable.append(candidate["revision_id"])
    touched = sorted({revision for revision_id in deletable
                      for revision in references.get(revision_id, ())})
    events = _planned_events(db, touched, deletable)
    counts = {
        "source_minutes": sum(1 for candidate in candidates if candidate["head"]),
        "source_revisions": len(revisions),
        "composite_minutes": sum(minute_rows.get(revision, 0) for revision in deletable),
        "composite_inputs": sum(input_rows.get(revision, 0) for revision in deletable),
        "composite_input_events": events,
    }
    payload_bytes = sum(payload.get(revision, 0) for revision in deletable)
    estimated = (payload_bytes + counts["source_minutes"] * SOURCE_MINUTE_BYTES +
                 counts["composite_minutes"] * COMPOSITE_MINUTE_BYTES +
                 counts["composite_inputs"] * COMPOSITE_INPUT_BYTES +
                 counts["composite_input_events"] * COMPOSITE_EVENT_BYTES)
    detail, by_reason = [], {}
    for candidate in candidates:
        reasons = blocked.get(candidate["revision_id"])
        if not reasons:
            continue
        for reason in reasons:
            by_reason[reason] = by_reason.get(reason, 0) + 1
        if len(detail) < MAX_DETAIL:
            detail.append({"source_id": candidate["source_id"], "start": candidate["start"],
                           "revision_id": candidate["revision_id"], "reasons": reasons})
    blocked_minutes = [(candidate["source_id"], candidate["start"])
                       for candidate in candidates
                       if candidate["head"] and candidate["revision_id"] in blocked]
    blocked_revisions = [candidate["revision_id"] for candidate in candidates
                         if not candidate["head"] and candidate["revision_id"] in blocked]
    return {
        "deletable": deletable,
        "blocked": blocked,
        "blocked_minutes": blocked_minutes,
        "blocked_revisions": blocked_revisions,
        "touched": touched,
        "counts": counts,
        "bytes": estimated,
        "payload_bytes": payload_bytes,
        "by_reason": by_reason,
        "detail": detail,
        "detail_truncated": len(blocked) > len(detail),
    }


def _planned_events(db, touched, deletable):
    """Events whose every referencing input row leaves in this pass."""
    if not touched:
        return 0
    deleted = set(deletable)
    surviving, all_events = set(), set()
    for chunk in _chunks(touched):
        for event_id, source_revision_id in db.execute(select(
                CompositeMinuteInput.event_id, CompositeMinuteInput.source_revision_id).where(
                    CompositeMinuteInput.revision_id.in_(chunk))):
            all_events.add(event_id)
            if source_revision_id not in deleted:
                surviving.add(event_id)
        for (event_id,) in db.execute(select(CompositeInputEvent.id).where(
                CompositeInputEvent.revision_id.in_(chunk))):
            all_events.add(event_id)
    return len(all_events - surviving)


def _delete(db, plan):
    """Delete one bounded plan in real foreign-key order; return row counts."""
    deletable = plan["deletable"]
    touched = plan["touched"]
    counts = _zero_deleted()
    if not deletable or not touched:
        return counts
    # Every referencing revision of a deletable candidate is unprotected by
    # construction; the explicit allowlist keeps the statements fail-closed.

    for chunk in _chunks(deletable):
        counts["market_composite_minute_inputs"] += db.execute(delete(
            CompositeMinuteInput).where(
                CompositeMinuteInput.source_revision_id.in_(chunk),
                CompositeMinuteInput.revision_id.in_(touched))).rowcount
        counts["market_composite_minutes"] += db.execute(delete(
            CompositeMinute).where(
                CompositeMinute.source_revision_id.in_(chunk),
                CompositeMinute.revision_id.in_(touched))).rowcount
    for chunk in _chunks(touched):
        counts["market_composite_input_events"] += db.execute(delete(
            CompositeInputEvent).where(
                CompositeInputEvent.revision_id.in_(chunk),
                ~exists().where(CompositeMinuteInput.event_id == CompositeInputEvent.id))).rowcount
    for chunk in _chunks(deletable):
        counts["market_source_minutes"] += db.execute(delete(SourceMinute).where(
            SourceMinute.revision_id.in_(chunk))).rowcount
        counts["market_source_minute_revisions"] += db.execute(delete(
            SourceMinuteRevision).where(
                SourceMinuteRevision.id.in_(chunk))).rowcount
    return counts


def _plan_report(plan):
    return {
        "candidates": dict(plan["counts"]),
        "rows": sum(plan["counts"].values()),
        "bytes": plan["bytes"],
        "payload_bytes": plan["payload_bytes"],
        "deletable_revisions": len(plan["deletable"]),
        "protected": {
            "revisions": len(plan["blocked"]),
            "by_reason": dict(sorted(plan["by_reason"].items())),
            "detail": plan["detail"],
            "detail_truncated": plan["detail_truncated"],
        },
    }


def schema_signature(connection=None):
    """Schema identity a restore drill was verified against."""

    def measure(conn):
        tables = sorted(inspect(conn).get_table_names())
        digest = hashlib.sha256("\n".join(tables).encode()).hexdigest()
        version = None
        if "alembic_version" in tables:
            version = conn.execute(
                text("SELECT version_num FROM alembic_version")).scalars().first()
        return {"tables": len(tables), "digest": digest, "alembic": version}

    if connection is not None:
        return measure(connection)
    with transaction() as db:
        return measure(db.connection())


def restore_marker():
    with transaction() as db:
        row = db.get(Preference, RESTORE_KEY)
        return dict(row.value) if row is not None else None


def save_restore_drill(record):
    """Persist one already-performed restore verification as the deletion gate."""
    marker = {
        "artifact": str(record["artifact"]),
        "sha256": str(record["sha256"]),
        "verified_at": int(record.get("verified_at") or now_ms()),
        "tables": int(record["tables"]),
        "backend": record.get("backend"),
        "bytes": record.get("bytes"),
        "schema": dict(record.get("schema") or schema_signature()),
    }
    with transaction() as db:
        row = db.get(Preference, RESTORE_KEY)
        if row is None:
            db.add(Preference(key=RESTORE_KEY, value=marker))
        else:
            row.value = marker
    return marker


def restore_drill(directory):
    """One real backup plus one real restore verification, recorded as the gate."""
    from sqlalchemy.engine import make_url

    from .config import settings

    directory = Path(directory)
    backend = make_url(settings.database_url).get_backend_name()
    suffix = ".db" if backend == "sqlite" else ".dump"
    artifact = directory / ("retention-restore-" + uuid4().hex + suffix)
    record = backup.backup(artifact)
    verified = backup.restore_check(artifact)
    return save_restore_drill({
        "artifact": artifact,
        "sha256": record["sha256"],
        "verified_at": now_ms(),
        "tables": verified["tables"],
        "backend": record["backend"],
        "bytes": record["bytes"],
    })


def _gate():
    marker = restore_marker()
    if not marker:
        return {"ok": False, "reason": "restore_drill_missing",
                "detail": "首次真实删除前必须先执行一次备份的实际恢复校验"}
    current = schema_signature()
    if marker.get("schema") != current:
        return {"ok": False, "reason": "restore_drill_schema_mismatch",
                "detail": {"recorded": marker.get("schema"), "current": current}}
    return {"ok": True, "reason": None, "marker": marker}


def _remaining(lower):
    with transaction() as db:
        head_pointer = exists().where(
            SourceMinute.revision_id == SourceMinuteRevision.id)
        heads = db.scalar(select(func.count()).select_from(SourceMinute).where(
            SourceMinute.start < lower))
        orphans = db.scalar(select(func.count()).select_from(SourceMinuteRevision).where(
            SourceMinuteRevision.start < lower, ~head_pointer))
        return int(heads or 0), int(orphans or 0)


def _blank_report(*, dry_run, stamp, lower):
    return {
        "run": None,
        "dry_run": dry_run,
        "window_hours": WINDOW_HOURS,
        "lower_bound": lower,
        "now": stamp,
        "deleted": _zero_deleted(),
        "rows": 0,
        "bytes": 0,
        "candidates": {"source_minutes": 0, "source_revisions": 0, "composite_minutes": 0,
                       "composite_inputs": 0, "composite_input_events": 0},
        "protected": {"revisions": 0, "by_reason": {}, "detail": [], "detail_truncated": False},
        "remaining": None,
        "batch": None,
        "skipped": [],
    }


def _pass(run_id, *, dry_run, limit=DEFAULT_LIMIT, chunk=DEFAULT_CHUNK,
          budget_ms=DEFAULT_BUDGET_MS, now=None):
    run = switch_runs.get(run_id)
    if run is None:
        raise ValueError("切换运行不存在：" + str(run_id))
    stamp = now_ms() if now is None else int(now)
    lower = stamp - WINDOW_MS
    report = _blank_report(dry_run=dry_run, stamp=stamp, lower=lower)
    report.update({"run": _run_summary(run), "limit": limit, "chunk": chunk,
                   "budget_ms": budget_ms})
    # Re-check the unlock here as well: the batch API refuses other runs, but the
    # tick layer must report why it stayed idle instead of failing silently.
    if not run["unlocked"]:
        report["skipped"].append({
            "reason": "switch_run_" + str(run["state"]),
            "detail": "只有持久化的 succeeded 切换运行解锁清理"})
        return report
    if dry_run:
        claimed = switch_runs.claim_retention(run_id, dry_run=True)
        report["batch"] = _batch_summary(claimed)
        deadline = now_ms() + budget_ms
        with transaction() as db:
            plan = _plan(db, lower=lower, limit=limit, now=stamp, deadline=deadline)
        report.update(_plan_report(plan))
        switch_runs.release_retention(run_id, outcome="completed", stats={
            "planned_rows": report["rows"], "planned_bytes": report["bytes"],
            "dry_run": True, "at": stamp})
        return report
    gate = _gate()
    if not gate["ok"]:
        report["skipped"].append({"reason": gate["reason"], "detail": gate["detail"]})
        return report
    claimed = switch_runs.claim_retention(run_id, dry_run=False)
    report["batch"] = _batch_summary(claimed)
    segment = dict(claimed.get("retention") or {})
    if segment.get("state") == "completed":
        report["skipped"].append({
            "reason": "batch_completed",
            "detail": "该切换运行的清理批次已完成；同一运行 ID 重跑不再删除"})
        report["idempotent"] = True
        return report
    previous = dict(segment.get("stats") or {})
    totals = {
        "rows": int(previous.get("rows") or 0),
        "bytes": int(previous.get("bytes") or 0),
        "deleted": {name: int((previous.get("deleted") or {}).get(name) or 0)
                    for name in DELETION_ORDER},
    }
    deadline = now_ms() + budget_ms
    processed, exhausted = 0, False
    skip_minutes, skip_revisions = set(), set()
    try:
        while processed < limit:
            size = min(chunk, limit - processed)
            applied = _apply_chunk(run_id=run_id, lower=lower, limit=size, now=stamp,
                                   deadline=deadline, skip_minutes=skip_minutes,
                                   skip_revisions=skip_revisions, totals=totals)
            summary, deleted, planned_bytes = (applied["summary"], applied["deleted"],
                                               applied["bytes"])
            # A protected candidate cannot become deletable inside one pass, so the
            # rest of the pass skips it instead of rescanning the same prefix.
            skip_minutes.update(applied["blocked_minutes"])
            skip_revisions.update(applied["blocked_revisions"])
            candidates = summary["candidates"]
            for key, value in candidates.items():
                report["candidates"][key] += value
            report["protected"]["revisions"] += summary["protected"]["revisions"]
            for reason, count in summary["protected"]["by_reason"].items():
                report["protected"]["by_reason"][reason] = (
                    report["protected"]["by_reason"].get(reason, 0) + count)
            spare = MAX_DETAIL - len(report["protected"]["detail"])
            if spare > 0:
                report["protected"]["detail"].extend(summary["protected"]["detail"][:spare])
            report["protected"]["detail_truncated"] |= summary["protected"]["detail_truncated"]
            for name in DELETION_ORDER:
                report["deleted"][name] += deleted[name]
            passed = sum(deleted.values())
            report["rows"] += passed
            report["bytes"] += planned_bytes
            processed += candidates["source_minutes"] + candidates["source_revisions"]
            if not summary["deletable_revisions"]:
                if not (candidates["source_minutes"] or candidates["source_revisions"]):
                    exhausted = True
                    break
                # Everything selected was protected. Those keys are skipped from now
                # on, so keep planning instead of stopping on a protected prefix.
                _checkpoint(run_id, totals)
                if now_ms() > deadline:
                    break
                continue
            if not passed:
                break
            _checkpoint(run_id, totals)
            if now_ms() > deadline:
                break
    except Exception:
        switch_runs.release_retention(run_id, outcome="interrupted", stats=_stats(totals, None))
        raise
    heads, orphans = _remaining(lower)
    report["remaining"] = {"source_minutes": heads, "source_revisions": orphans}
    finished = exhausted or (heads == 0 and orphans == 0)
    released = switch_runs.release_retention(
        run_id, outcome="completed" if finished else "interrupted",
        stats=_stats(totals, report["remaining"]))
    report["batch"] = _batch_summary(released)
    return report


def _stats(totals, remaining):
    return {
        "rows": totals["rows"],
        "bytes": totals["bytes"],
        "deleted": dict(totals["deleted"]),
        "remaining": remaining,
        "at": now_ms(),
    }


def _project(totals, deleted, planned_bytes):
    return {
        "rows": totals["rows"] + sum(deleted.values()),
        "bytes": totals["bytes"] + planned_bytes,
        "deleted": {name: totals["deleted"].get(name, 0) + deleted[name]
                    for name in DELETION_ORDER},
    }


def _persist(db, run_id, totals):
    """Write the batch counts inside the caller's transaction, never after it."""
    row = db.get(MarketSwitchRun, run_id)
    if row is None:
        raise ValueError("切换运行不存在：" + str(run_id))
    segment = dict(row.retention or {})
    segment["stats"] = _stats(totals, None)
    row.retention = segment


def _checkpoint(run_id, totals):
    """Leave committed progress resumable on the same batch."""
    switch_runs.release_retention(run_id, outcome="interrupted", stats=_stats(totals, None))
    switch_runs.claim_retention(run_id, dry_run=False)


def _apply_chunk(*, run_id, lower, limit, now, deadline, skip_minutes, skip_revisions, totals):
    """Delete one chunk and record its counts before the commit.

    The batch statistics are written in the deletion transaction, so a process
    killed between a commit and the release cannot lose the evidence of rows it
    already removed; the resumed totals stay equal to what the database lost.
    """
    with transaction() as db:
        plan = _plan(db, lower=lower, limit=limit, now=now, deadline=deadline,
                     skip_minutes=skip_minutes, skip_revisions=skip_revisions)
        summary = _plan_report(plan)
        deleted = _delete(db, plan)
        projected = _project(totals, deleted, plan["bytes"])
        _persist(db, run_id, projected)
        applied = {"summary": summary, "deleted": deleted, "bytes": plan["bytes"],
                   "blocked_minutes": plan["blocked_minutes"],
                   "blocked_revisions": plan["blocked_revisions"]}
    totals.update(projected)
    return applied


def dry_run(run_id=None, *, limit=DEFAULT_LIMIT, chunk=DEFAULT_CHUNK,
            budget_ms=DEFAULT_BUDGET_MS, now=None):
    """Report candidates, bytes and every protection skip; never deletes a row."""
    run_id = run_id or _unlocked_run_id(True)
    if run_id is None:
        return _idle("no_succeeded_switch_run")
    return _pass(run_id, dry_run=True, limit=limit, chunk=chunk,
                 budget_ms=budget_ms, now=now)


def execute(run_id=None, *, limit=DEFAULT_LIMIT, chunk=DEFAULT_CHUNK,
            budget_ms=DEFAULT_BUDGET_MS, now=None):
    """Delete one bounded batch for a succeeded switch run, in foreign-key order."""
    run_id = run_id or _unlocked_run_id(False)
    if run_id is None:
        return _idle("no_succeeded_switch_run")
    return _pass(run_id, dry_run=False, limit=limit, chunk=chunk,
                 budget_ms=budget_ms, now=now)


def _completed_for(run, dry_run):
    """A completed batch blocks only the same mode; claiming a new mode resets it."""
    segment = dict(run.get("retention") or {})
    return (segment.get("state") == "completed" and
            bool(segment.get("dry_run")) == bool(dry_run))


def _unlocked_run_id(dry_run):
    for run in switch_runs.unlocked_runs():
        if not _completed_for(run, dry_run):
            return run["id"]
    return None


def _idle(reason):
    report = _blank_report(dry_run=None, stamp=now_ms(), lower=lower_bound())
    report["skipped"] = [{"reason": reason, "detail": "没有持久化的 succeeded 切换运行"}]
    return report


def tick(*, dry_run=True, limit=DEFAULT_LIMIT, chunk=DEFAULT_CHUNK,
         budget_ms=DEFAULT_BUDGET_MS, now=None):
    """Restart-safe periodic entry: unlock verdict per run, then one bounded pass.

    Every recent run reports its own reason, so failed, partial, preparing,
    shadow_ready and activating rows are visibly refused rather than silently
    skipped.
    """
    with transaction() as db:
        ids = list(db.execute(select(MarketSwitchRun.id).order_by(
            MarketSwitchRun.created_at.desc(), MarketSwitchRun.id).limit(20)).scalars())
    verdicts, target = [], None
    for run_id in ids:
        run = switch_runs.get(run_id)
        batch_state = dict(run.get("retention") or {}).get("state")
        unlocked = run["state"] == switch_runs.UNLOCKED
        if not unlocked:
            reason = "switch_run_" + str(run["state"])
        elif _completed_for(run, dry_run):
            reason = "batch_completed"
        else:
            reason = None
            target = target or run
        verdicts.append({"id": run_id, "state": run["state"], "unlocked": unlocked,
                         "reason": reason, "batch_state": batch_state})
    if not verdicts:
        return {"unlocked": False, "reason": "no_switch_run", "runs": [], "report": None}
    if target is None:
        return {"unlocked": False, "reason": "no_unlocked_batch", "runs": verdicts,
                "report": None}
    report = _pass(target["id"], dry_run=dry_run, limit=limit, chunk=chunk,
                   budget_ms=budget_ms, now=now)
    return {"unlocked": True, "reason": None, "runs": verdicts, "report": report}
