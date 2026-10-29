"""One deduplicated switch summary per run, merged across retries.

A run owns at most one system message: the notification id is derived from the
run id, so a retried or repeated report merges into the same logical message and
never queues a second one.  The notification and its outbox row are written in
one transaction; a merge keeps the delivery attempt counters untouched.
"""

import uuid

from sqlalchemy import func, select

from .source_history_store import _insert
from .storage import Notification, Outbox, now_ms, transaction

TOPIC = "switch_run"
TITLES = {"failed": "组合修订切换失败", "partial": "组合修订切换部分生效",
          "succeeded": "组合修订切换完成"}
MAX_ERRORS = 20
MAX_MESSAGE = 2000
# A delivered message is delivered once per error set: these finished states are
# reopened for a new error. `cancelled` is a deliberate retire and stays closed.
REQUEUE_AFTER = ("accepted", "blocked")


def notice_id(run_id):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, "market-watch/switch-notice/" + run_id))


def outbox_id(run_id):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, "market-watch/switch-outbox/" + run_id))


def error_key(item):
    """Per-stage, per-rule identity: the same failure merges, a new one appends."""
    return "|".join(str(item.get(field) or "") for field in ("stage", "scope", "type"))


def message(payload):
    counts, errors = payload.get("counts", {}), payload.get("errors", [])
    lines = [f"切换运行 {payload['run_id']}（第 {int(payload.get('attempts', 0)) + 1} 次尝试）",
             f"运行状态：{payload['state']}；失败阶段：{payload.get('stage') or '无'}",
             f"受影响：来源 {counts.get('sources', 0)} 个，规则 {counts.get('rules', 0)} 条，"
             f"已暂停 {counts.get('paused', 0)} 条",
             f"当前有效修订：{counts.get('active_revision_id') or '无'}；清理未解锁"]
    lines += [f"- [{item.get('stage')}] {item.get('reason')}" for item in errors]
    return "\n".join(lines)[:MAX_MESSAGE]


def _merge(payload, *, stage, reasons, counts, state, attempts, now):
    """Merge by error key; returns the payload and the keys this call introduced."""
    errors = list(payload.get("errors") or [])
    introduced = []
    for item in reasons:
        key = error_key(item)
        seen = next((index for index, entry in enumerate(errors) if entry["key"] == key), None)
        if seen is not None:
            # Replace the entry: an in-place mutation is invisible to the JSON column.
            errors[seen] = {**errors[seen], "seen": int(errors[seen].get("seen", 1)) + 1,
                            "last_at": now}
            continue
        introduced.append(key)
        errors.append({"key": key, "stage": item.get("stage"), "scope": item.get("scope"),
                       "type": item.get("type"), "reason": str(item.get("reason"))[:300],
                       "at": now, "last_at": now, "seen": 1})
    merged = {**payload, "topic": TOPIC, "run_id": payload["run_id"], "state": state,
              "stage": stage, "attempts": attempts,
              "counts": {**payload.get("counts", {}), **counts}, "errors": errors[:MAX_ERRORS],
              "title": TITLES.get(state, TITLES["failed"]), "updated_at": now}
    merged["message"] = message(merged)
    return merged, introduced


def _requeue(db, note, *, now):
    """Deliver a merged message again: same row, same attempts counter."""
    row = db.scalar(select(Outbox).where(Outbox.notification_id == note.id).with_for_update())
    if row is None or row.status not in REQUEUE_AFTER:
        return False
    row.status, row.next_at, row.lease_until = "pending", now, None
    return True


def record(db, *, run, stage, reasons, counts, now=None):
    """Insert once per run, then merge; the outbox row is never duplicated.

    A merge that introduces a genuinely new error after the message was already
    delivered puts the *same* outbox row back to pending, so the merged errors
    reach the user. A repeated error only bumps its counter and never re-sends.
    """
    now = now_ms() if now is None else now
    key = notice_id(run["id"])
    # rowcount is not portable for ON CONFLICT DO NOTHING; existence decides.
    created = db.get(Notification, key) is None
    if created:
        db.execute(_insert(db)(Notification).values(
            id=key, kind="system", signal_id=None, status="pending",
            payload={"topic": TOPIC, "run_id": run["id"],
                     "incident_id": "switch-run:" + run["id"],
                     "title": TITLES.get(run["state"], TITLES["failed"]), "message": "",
                     "state": run["state"], "stage": stage, "attempts": run.get("attempts", 0),
                     "counts": {}, "errors": []},
            created_at=now).on_conflict_do_nothing(index_elements=["id"]))
    note = db.scalar(select(Notification).where(Notification.id == key).with_for_update())
    note.payload, introduced = _merge(note.payload or {"run_id": run["id"]}, stage=stage,
        reasons=reasons, counts=counts, state=run["state"],
        attempts=run.get("attempts", 0), now=now)
    if created:
        db.execute(_insert(db)(Outbox).values(id=outbox_id(run["id"]), notification_id=note.id,
            status="pending", attempts=0, next_at=now, lease_until=None, error=None,
            provider_id=None).on_conflict_do_nothing(index_elements=["id"]))
    requeued = bool(introduced) and not created and _requeue(db, note, now=now)
    db.flush()
    return {"notification_id": note.id, "created": created, "new_errors": len(introduced),
            "requeued": requeued,
            "outbox_rows": db.scalar(select(func.count()).select_from(Outbox).where(
                Outbox.notification_id == note.id)),
            "errors": len(note.payload["errors"])}


def emit(*, run, stage, reasons, counts, now=None):
    """Durable report for callers that own their transaction boundary."""
    with transaction() as db:
        return record(db, run=run, stage=stage, reasons=reasons, counts=counts, now=now)
