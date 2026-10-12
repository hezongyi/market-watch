"""Bounded per-role business heartbeats; queue counts are separate evidence."""

import logging

from sqlalchemy import func, select

from .config import settings
from .storage import HistoryVersion, ImportJob, NativeHistoryLoad, Preference, now_ms, transaction

ROLES = {
    "history_versions": ("自建历史发布", "历史导入、派生与发布可能延迟"),
    "chart_history": ("图表历史补齐", "来源目录刷新、旧绑定图表历史与导入任务可能延迟"),
    "native_history": ("平台图表加载", "平台原生历史分页可能等待或过期"),
    "legacy_import": ("兼容补数链路", "旧版自动补数可能延迟；不代表现行历史服务故障"),
}
STALE_MS = 300_000


def heartbeat(role, *, state="idle", errors=(), worked=False):
    if role not in ROLES:
        raise ValueError("Unknown worker role")
    with transaction() as db:
        key, at = "worker_health:" + role, now_ms()
        row = db.get(Preference, key)
        previous = row.value if row else {}
        # Starting a retry is not recovery. Retain its fault until a cycle
        # actually finishes successfully, including if the retry then hangs.
        reported_errors = (
            previous.get("errors", []) if state == "working" and not errors else list(errors)
        )
        value = {
            **previous,
            "at": at,
            "state": state,
            "errors": reported_errors,
            "worked": bool(worked),
        }
        if state == "idle" and not errors:
            value["last_success_at"] = at
        if row:
            row.value = value
        else:
            db.add(Preference(key=key, value=value))


class Pulse:
    """Write at most one successful cycle pair per 30s; faults report immediately."""

    def __init__(self, role):
        self.role, self.next_at, self.recording = role, 0, False

    def start(self):
        self.recording = now_ms() >= self.next_at
        if self.recording:
            self._report(state="working")

    def finish(self, *, worked=False, errors=()):
        if self.recording or errors:
            self._report(state="degraded" if errors else "idle", worked=worked, errors=errors)
            self.next_at = 0 if errors else now_ms() + 30_000
        self.recording = False

    def _report(self, **value):
        try:
            heartbeat(self.role, **value)
        except Exception as error:
            # Failure to report cannot stop unrelated worker phases. The old
            # timestamp stays stale; no artificial success replaces it.
            logging.warning(
                "worker heartbeat unavailable role=%s type=%s", self.role, type(error).__name__
            )


def services(db, *, at=None):
    at = now_ms() if at is None else at
    expected = set(settings.history_health_workers)
    counts = {
        "history_versions": dict(
            db.execute(
                select(HistoryVersion.status, func.count()).group_by(HistoryVersion.status)
            ).all()
        ),
        "chart_history": dict(
            db.execute(
                select(ImportJob.status, func.count())
                .where(ImportJob.priority > 0)
                .group_by(ImportJob.status)
            ).all()
        ),
        "native_history": dict(
            db.execute(
                select(NativeHistoryLoad.state, func.count()).group_by(NativeHistoryLoad.state)
            ).all()
        ),
        "legacy_import": {},
    }
    progress = {
        "history_versions": [
            {
                "id": row.id,
                "state": row.status,
                "cursor": row.cursor,
                "start": row.start,
                "end": row.end,
                "updated_at": row.updated_at,
            }
            for row in db.scalars(
                select(HistoryVersion).order_by(HistoryVersion.created_at.desc()).limit(5)
            )
        ],
        "chart_history": [
            {
                "id": row.id,
                "state": row.status,
                "cursor": row.cursor,
                "start": row.start,
                "end": row.end,
            }
            for row in db.scalars(
                select(ImportJob)
                .where(ImportJob.priority > 0)
                .order_by(ImportJob.created_at.desc())
                .limit(5)
            )
        ],
        "native_history": [
            {"id": row.id, "state": row.state, "pages": row.pages, "stalls": row.stalls}
            for row in db.scalars(
                select(NativeHistoryLoad).order_by(NativeHistoryLoad.created_at.desc()).limit(5)
            )
        ],
        "legacy_import": [],
    }
    result = []
    for role, (label, impact) in ROLES.items():
        record = db.get(Preference, "worker_health:" + role)
        value = record.value if record else {}
        heartbeat_at = value.get("at")
        status = (
            "disabled"
            if role not in expected
            else "unknown"
            if heartbeat_at is None
            else "stale"
            if at - heartbeat_at >= STALE_MS
            else "degraded"
            if value.get("errors")
            else "running"
        )
        result.append(
            {
                "id": role,
                "label": label,
                "role": "compatibility" if role == "legacy_import" else "current",
                "status": status,
                "heartbeat_at": heartbeat_at,
                "last_success_at": value.get("last_success_at"),
                "state": value.get("state"),
                "errors": value.get("errors", []),
                "impact": impact,
                "stale_after_seconds": STALE_MS // 1000,
                "task_counts": counts[role],
                "recent_tasks": progress[role],
                "task_scope": "共享旧版历史队列（排除实时修复）"
                if role == "chart_history"
                else None,
            }
        )
    return result
