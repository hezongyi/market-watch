"""Managed history schedules and resumable immutable incremental versions.

Stopping the schedule and pausing a running task are separate operations. A run
fixes its parent and refresh range; all other original chunks remain reusable.
"""

import hashlib
import json
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select

from .chart_data import FRAMES
from .history_sources import history_identity
from .source_history_store import raw_chunk, store_blob
from .source_registry import collection_identity
from .storage import (
    DatasetMaintenance,
    HistoryArtifact,
    HistoryChunk,
    HistoryReclamation,
    HistoryRun,
    HistoryVersion,
    MarketDataset,
    now_ms,
    transaction,
)


def next_daily(stamp, minute, timezone):
    if isinstance(minute, bool) or not isinstance(minute, int) or not 0 <= minute < 1440:
        raise ValueError("每日维护时间必须是0–1439的分钟数")
    zone = ZoneInfo(timezone)
    now = datetime.fromtimestamp(stamp / 1000, UTC).astimezone(zone)
    candidate = now.replace(hour=minute // 60, minute=minute % 60, second=0, microsecond=0)
    if candidate <= now:
        candidate += timedelta(days=1)
    return int(candidate.timestamp() * 1000)


def latest_version(db, dataset_id):
    return db.scalar(select(HistoryVersion).where(HistoryVersion.dataset_id == dataset_id,
        HistoryVersion.status == "published",
        ~select(HistoryReclamation.version_id).where(HistoryReclamation.version_id == HistoryVersion.id).exists())
        .order_by(HistoryVersion.end.desc(),
            HistoryVersion.published_at.desc(), HistoryVersion.id).limit(1))


def configure(db, dataset_id, *, target_start, timeframes, frequency="daily", timezone="UTC",
              daily_minute=15, overlap_minutes=2880):
    dataset = db.scalar(select(MarketDataset).where(MarketDataset.id == dataset_id).with_for_update())
    if not dataset:
        raise ValueError("数据集不存在")
    history_identity(dataset.identity)
    if not 0 <= target_start < (now_ms() - 5000) // 60000 * 60000 or target_start % 60000:
        raise ValueError("历史起点必须是已结束的UTC分钟边界")
    if not timeframes or any(f not in FRAMES for f in timeframes):
        raise ValueError("请选择支持的自建周期")
    if frequency not in ("daily", "once") or not 0 <= overlap_minutes <= 31 * 1440:
        raise ValueError("不支持的维护频率或复查窗口")
    next_at = next_daily(now_ms(), daily_minute, timezone)
    plan = db.get(DatasetMaintenance, dataset_id)
    if plan is None:
        latest = latest_version(db, dataset_id)
        plan = DatasetMaintenance(dataset_id=dataset_id, latest_version_id=latest.id if latest else None)
        db.add(plan)
    plan.target_start = target_start
    plan.timeframes = [f for f in FRAMES if f in set(timeframes) | {"M1"}]
    plan.frequency, plan.timezone, plan.daily_minute = frequency, timezone, daily_minute
    plan.overlap_minutes, plan.next_at, plan.updated_at = overlap_minutes, next_at, now_ms()
    db.flush()
    published = db.get(HistoryVersion, plan.latest_version_id) if plan.latest_version_id else latest_version(db, dataset_id)
    if published:
        from .history_artifacts import request_artifacts

        request_artifacts(db, published, plan.timeframes)
    return plan


def create_run(db, dataset_id, *, kind="update", start=None, end=None, request_id):
    from .history_versions import create_version

    db.scalar(select(MarketDataset).where(MarketDataset.id == dataset_id).with_for_update())
    plan = db.get(DatasetMaintenance, dataset_id)
    if not plan:
        raise ValueError("请先配置自建行情维护计划")
    if kind not in ("update", "backfill", "recheck") or not request_id or len(request_id) > 100:
        raise ValueError("不支持的任务类型或提交标识")
    # Hash submitted intent before resolving defaults: retrying a timed-out
    # request must retrieve the same fixed cutoff, even on the next UTC minute.
    digest = hashlib.sha256(json.dumps({"kind": kind, "start": start, "end": end},
                                      sort_keys=True).encode()).hexdigest()
    existing = db.scalar(select(HistoryRun).where(HistoryRun.dataset_id == dataset_id,
                                                HistoryRun.request_id == request_id))
    if existing:
        if existing.request_hash != digest:
            raise ValueError("相同提交标识不能改写任务范围")
        return db.get(HistoryVersion, existing.version_id)
    if plan.archived:
        raise ValueError("请先取消归档再创建维护任务")
    parent = db.get(HistoryVersion, plan.latest_version_id) if plan.latest_version_id else latest_version(db, dataset_id)
    cutoff = (now_ms() - 5000) // 60000 * 60000
    if kind != "update" and (start is None or end is None):
        raise ValueError("补数与复查必须指定固定区间")
    left = start if start is not None else max(plan.target_start,
        parent.end - plan.overlap_minutes * 60000 if parent else plan.target_start)
    right = cutoff if end is None else end
    if not 0 <= left < right <= cutoff or left % 60000 or right % 60000:
        raise ValueError("任务需要已结束的UTC分钟区间")
    if plan.active_version_id:
        active = db.get(HistoryVersion, plan.active_version_id)
        run = db.get(HistoryRun, active.id)
        if run.completed_at is None and run.desired_state != "cancelled":
            if kind == "update" and run.kind == "update" and run.refresh_end == right and start is None:
                return active
            raise ValueError("已有维护任务，请先完成或取消该任务")
    ident = create_version(db, dataset_id,
        min(left, plan.target_start, parent.start if parent else left),
        max(right, parent.end if parent else right))
    version = db.get(HistoryVersion, ident)
    version.manifest = {"maintenance": {"parent_version": parent.id if parent else None,
        "refresh_start": left, "refresh_end": right, "kind": kind, "timeframes": plan.timeframes}}
    db.add(HistoryRun(version_id=ident, dataset_id=dataset_id, request_id=request_id,
        request_hash=digest, kind=kind, parent_version_id=parent.id if parent else None,
        refresh_start=left, refresh_end=right))
    plan.active_version_id, plan.last_attempt, plan.updated_at = ident, now_ms(), now_ms()
    db.flush()
    return version


def reusable_page(db, version, run):
    """Return at most one untouched original partition or clipped edge."""
    if not run or not run.parent_version_id or run.refresh_start <= version.cursor < run.refresh_end:
        return None
    source = db.scalar(select(HistoryChunk).where(HistoryChunk.version_id == run.parent_version_id,
        HistoryChunk.start <= version.cursor, HistoryChunk.end > version.cursor).limit(1))
    if not source:
        return None
    right = min(source.end, version.end)
    if version.cursor < run.refresh_start:
        right = min(right, run.refresh_start)
    raw = raw_chunk(db, source)
    if (version.cursor, right) == (source.start, source.end):
        return HistoryChunk(version_id=version.id, start=source.start, end=source.end,
            observed_at=source.observed_at, count=source.count, checksum=source.checksum,
            content=source.content, content_id=source.content_id, result=source.result, unknown=source.unknown)
    from .history_versions import _unknown
    from .market_contracts import MinuteRow

    rows = [MinuteRow.model_validate(row) for row in json.loads(raw)
            if version.cursor <= row["timestamp"] < right]
    raw = json.dumps([row.model_dump() for row in rows], sort_keys=True, separators=(",", ":")).encode()
    dataset = db.get(MarketDataset, version.dataset_id)
    content_id, checksum = store_blob(db, collection_identity(dataset.identity).key, raw)
    return HistoryChunk(version_id=version.id, start=version.cursor, end=right,
        observed_at=source.observed_at, count=len(rows), checksum=checksum,
        content=b"", content_id=content_id, result="data" if rows else "empty_success",
        unknown=_unknown(rows, version.cursor, right))


def bounded_refresh(db, version, end):
    run = db.get(HistoryRun, version.id)
    if run and run.parent_version_id:
        for boundary in (run.refresh_start, run.refresh_end):
            if version.cursor < boundary < end:
                end = boundary
        parent = db.get(HistoryVersion, run.parent_version_id)
        if version.cursor < parent.start < end:
            end = parent.start
    return end


def on_publish(db, version):
    run = db.get(HistoryRun, version.id)
    if not run:
        return
    plan = db.get(DatasetMaintenance, version.dataset_id)
    if plan.active_version_id == version.id:
        plan.latest_version_id, plan.updated_at = version.id, now_ms()


def finish_run(db, version_id):
    """Complete a maintenance run only after its fixed requested periods publish.

    Called after the artifact transaction commits, so parallel builders see
    each other's publication. The scheduler also reconciles after a crash.
    """
    version = db.get(HistoryVersion, version_id)
    if not version or version.status != "published":
        return False
    db.scalar(select(MarketDataset).where(MarketDataset.id == version.dataset_id).with_for_update())
    run = db.get(HistoryRun, version_id)
    if not run or run.completed_at is not None or run.desired_state != "running":
        return False
    requested = set(version.manifest.get("maintenance", {}).get("timeframes", ["M1"]))
    published = set(db.scalars(select(HistoryArtifact.timeframe).where(
        HistoryArtifact.version_id == version_id, HistoryArtifact.status == "published")))
    if not requested <= published:
        return False
    run.completed_at = now_ms()
    plan = db.get(DatasetMaintenance, version.dataset_id)
    if plan.active_version_id == version_id:
        plan.active_version_id = None
        plan.last_success, plan.updated_at = run.completed_at, now_ms()
    return True


def task_status(db, version):
    run = db.get(HistoryRun, version.id)
    if version.status != "published" or not run or run.completed_at is not None:
        return version.status
    return "deriving" if run.desired_state == "running" else run.desired_state


def task_control(db, version_id, action):
    parent = db.get(HistoryVersion, version_id)
    if parent:
        db.scalar(select(MarketDataset).where(MarketDataset.id == parent.dataset_id).with_for_update())
    version = db.scalar(select(HistoryVersion).where(HistoryVersion.id == version_id).with_for_update())
    if not version or not db.get(HistoryRun, version_id):
        raise ValueError("维护任务不存在")
    if action not in ("pause", "resume", "retry", "cancel"):
        raise ValueError("不支持的任务操作")
    run = db.get(HistoryRun, version_id)
    if version.status == "published":
        if run.completed_at is not None:
            raise ValueError("已发布版本不可改写；请新建复查任务")
        if run.desired_state == "cancelled":
            raise ValueError("已取消任务请重新提交维护；原任务记录保留")
        run.desired_state = {"pause": "paused", "cancel": "cancelled"}.get(action, "running")
        if action == "cancel":
            plan = db.get(DatasetMaintenance, version.dataset_id)
            if plan.active_version_id == version.id:
                plan.active_version_id = None
        # Published M1 and completed period artifacts remain immutable.
        return version
    if action in ("pause", "cancel"):
        run.desired_state = "paused" if action == "pause" else "cancelled"
        if version.lease_until <= now_ms():
            version.status = run.desired_state
            version.lease_token, version.lease_until = None, 0
    else:
        if version.status == "cancelled":
            raise ValueError("已取消任务请重新提交维护；原任务记录保留")
        if version.lease_until > now_ms() and run.desired_state != "running":
            raise ValueError("任务仍在安全停止中，请稍后恢复")
        run.desired_state = "running"
        version.status, version.error, version.next_at = "pending", None, 0
    if version.status == "cancelled":
        plan = db.get(DatasetMaintenance, version.dataset_id)
        if plan.active_version_id == version.id:
            plan.active_version_id = None
    return version


def schedule_tick():
    """One bounded due schedule; explicit task controls reconcile after a crash."""
    with transaction() as db:
        unfinished = db.scalar(select(HistoryRun.version_id).join(HistoryVersion,
            HistoryVersion.id == HistoryRun.version_id).where(
            HistoryVersion.status == "published", HistoryRun.completed_at.is_(None),
            HistoryRun.desired_state == "running",
            ~select(HistoryArtifact.id).where(HistoryArtifact.version_id == HistoryRun.version_id,
                HistoryArtifact.status != "published").exists())
            .order_by(HistoryVersion.created_at).limit(1))
        if unfinished and finish_run(db, unfinished):
            return True
        controlled = db.scalar(select(HistoryVersion).join(HistoryRun,
            HistoryRun.version_id == HistoryVersion.id).join(MarketDataset,
            MarketDataset.id == HistoryVersion.dataset_id).where(HistoryRun.desired_state != "running",
            HistoryVersion.status.in_(("pending", "running", "retrying")),
            HistoryVersion.lease_until <= now_ms()).with_for_update(skip_locked=True, of=MarketDataset).limit(1))
        if controlled:
            from .history_versions import lock_version

            controlled = lock_version(db, controlled.id)
            controlled.status = db.get(HistoryRun, controlled.id).desired_state
            controlled.lease_token, controlled.lease_until = None, 0
            if controlled.status == "cancelled":
                plan = db.get(DatasetMaintenance, controlled.dataset_id)
                if plan.active_version_id == controlled.id:
                    plan.active_version_id = None
            return True
        # Lock the dataset before its plan, matching submission/configuration
        # order so multiple schedulers cannot deadlock with interactive changes.
        dataset = db.scalar(select(MarketDataset).join(DatasetMaintenance).where(
            DatasetMaintenance.frequency == "daily", DatasetMaintenance.paused.is_(False),
            DatasetMaintenance.archived.is_(False), DatasetMaintenance.next_at <= now_ms(),
            DatasetMaintenance.active_version_id.is_(None))
            .with_for_update(skip_locked=True, of=MarketDataset).limit(1))
        if not dataset:
            return False
        plan = db.get(DatasetMaintenance, dataset.id)
        if plan.active_version_id or plan.paused or plan.archived or plan.next_at > now_ms():
            return False
        create_run(db, dataset.id, request_id=f"daily:{plan.next_at}")
        plan.next_at = next_daily(now_ms(), plan.daily_minute, plan.timezone)
        return True


def plan_report(db, dataset_id):
    plan = db.get(DatasetMaintenance, dataset_id)
    if not plan:
        return {"configured": False}
    latest = db.get(HistoryVersion, plan.latest_version_id) if plan.latest_version_id else latest_version(db, dataset_id)
    active = db.get(HistoryVersion, plan.active_version_id) if plan.active_version_id else None
    return {"configured": True, "target_start": plan.target_start, "timeframes": plan.timeframes,
        "frequency": plan.frequency, "timezone": plan.timezone, "daily_minute": plan.daily_minute,
        "overlap_minutes": plan.overlap_minutes, "paused": plan.paused, "archived": plan.archived,
        "next_at": plan.next_at if plan.frequency == "daily" and not plan.paused and not plan.archived else None,
        "latest_version_id": latest.id if latest else None,
        "available_start": latest.start if latest else None, "available_end": latest.end if latest else None,
        "active_version_id": active.id if active else None, "task_status": task_status(db, active) if active else None,
        "task_error": active.error if active else None, "last_attempt": plan.last_attempt,
        "last_success": plan.last_success}
