"""Request outcomes and coverage are separate axes; retries retain all outcomes."""

import hashlib
import json

from sqlalchemy import func, select

from .storage import HistoryReadAttempt, HistoryVersion, now_ms

FIELDS = ("id", "start", "end", "started_at", "finished_at", "read_kind", "result",
          "checkpoint", "observed_at", "observations", "accepted")
SUCCESS = {"data", "empty_success", "inherited"}
LOCAL = {"shared_busy", "discarded", "interrupted"}


def attempt_id(token):
    # Public audit IDs must never disclose a live worker's fencing token.
    return hashlib.sha256(("history-read-audit|" + token).encode()).hexdigest()[:36]


def start(db, version_id, token, left, right):
    # A recovered import cannot invent the supplier outcome of a crashed reader.
    for pending in db.scalars(select(HistoryReadAttempt).where(
            HistoryReadAttempt.version_id == version_id, HistoryReadAttempt.finished_at.is_(None))):
        finish(pending, "interrupted")
    attempt = HistoryReadAttempt(id=attempt_id(token), version_id=version_id, start=left, end=right, started_at=now_ms())
    db.add(attempt)
    return attempt


def finish(attempt, result, *, batch=None, read_kind=None, accepted=False):
    if attempt.finished_at is not None:
        return  # A fenced old reader cannot change recovered request evidence.
    attempt.finished_at, attempt.result, attempt.accepted = now_ms(), result, accepted
    if read_kind:
        attempt.read_kind = read_kind
    if batch:
        attempt.checkpoint, attempt.observed_at, attempt.observations = batch.checkpoint, batch.observed_at, len(batch.rows)


def record(row, *, include_frame=False):
    fields = {key: getattr(row, key) for key in FIELDS}
    return fields | {"timeframe": row.timeframe} if include_frame else fields


def query(version_id):
    return select(HistoryReadAttempt).where(HistoryReadAttempt.version_id == version_id)


def snapshot(db, version_id):
    version = db.get(HistoryVersion, version_id)
    native = version.manifest.get("schema") == "managed-period-snapshot-v2"
    rows = [record(row, include_frame=native) for row in db.scalars(
        query(version_id).order_by(HistoryReadAttempt.started_at, HistoryReadAttempt.id))]
    encoded = json.dumps(rows, sort_keys=True, separators=(",", ":")).encode()
    return {"schema": "bounded-period-read-v2" if native else "bounded-m1-read-v1", "count": len(rows),
            "failed": sum(row["result"] not in SUCCESS | LOCAL | {"started"} for row in rows),
            "ids": [row["id"] for row in rows], "checksum": hashlib.sha256(encoded).hexdigest(),
            "scope": "version read attempts; supplier requests, shared cache and parent reuse distinguished"}


def report(db, version_id, *, page=1, page_size=25):
    version = db.get(HistoryVersion, version_id)
    if not version:
        raise ValueError("历史版本不存在")
    if page < 1 or not 1 <= page_size <= 100:
        raise ValueError("无效的请求记录分页")
    attempts = query(version_id)
    total = db.scalar(select(func.count()).select_from(attempts.subquery()))
    failed = db.scalar(select(func.count()).select_from(attempts.where(
        ~HistoryReadAttempt.result.in_(SUCCESS | LOCAL | {"started"})).subquery()))
    rows = db.scalars(attempts.order_by(HistoryReadAttempt.started_at.desc(), HistoryReadAttempt.id)
                      .offset((page - 1) * page_size).limit(page_size))
    native = version.manifest.get("schema") == "managed-period-snapshot-v2"
    return {"version_id": version_id, "items": [record(row, include_frame=native) for row in rows], "total": total,
            "failed": failed, "page": page, "page_size": page_size,
            "evidence_available": bool(total),
            "scope": "read attempts, not missing-minute classification; failed ranges may later be observed"}
