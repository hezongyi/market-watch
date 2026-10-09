"""Pure management queries shared by desktop UI and authenticated callers."""

from sqlalchemy import case, func, or_, select

from .history_maintenance import plan_report
from .market_names import code_search
from .storage import (
    DatasetMaintenance,
    HistoryArtifact,
    HistoryRun,
    HistoryVersion,
    Instrument,
    MarketDataset,
)


def dataset_detail(db, dataset_id):
    from .history_api import dataset_report
    from .history_artifacts import artifact_report

    dataset = db.get(MarketDataset, dataset_id)
    if not dataset:
        raise ValueError("数据集不存在")
    maintenance = plan_report(db, dataset.id)
    published = maintenance.get("latest_version_id")
    if not published:
        from .history_maintenance import latest_version

        latest = latest_version(db, dataset.id)
        published = latest.id if latest else None
    version = db.get(HistoryVersion, published) if published else None
    periods = artifact_report(db, published) if published else []
    # A newer M1 version does not hide the previously published H4/D1 while
    # their new artifacts build. Every period keeps its explicit parent ID.
    ranked = select(HistoryArtifact.id, func.row_number().over(partition_by=HistoryArtifact.timeframe,
        order_by=(HistoryVersion.end.desc(), HistoryVersion.published_at.desc(), HistoryArtifact.id)).label("position"))
    ranked = ranked.join(HistoryVersion).where(
        HistoryVersion.dataset_id == dataset.id, HistoryVersion.status == "published",
        HistoryArtifact.status == "published", HistoryArtifact.count > 0).subquery()
    candidates = db.scalars(select(HistoryArtifact).join(ranked, ranked.c.id == HistoryArtifact.id)
                           .where(ranked.c.position == 1)).all()
    available = {}
    for artifact in candidates:
        available.setdefault(artifact.timeframe, artifact)
    by_frame = {p["timeframe"]: p for p in periods}
    for frame, artifact in available.items():
        p = by_frame.setdefault(frame, {"id": artifact.id, "version_id": artifact.version_id,
            "timeframe": frame, "status": "published", "rows": artifact.count,
            "complete_rows": artifact.complete_count})
        parent = db.get(HistoryVersion, artifact.version_id)
        p.update(available_version_id=artifact.version_id, available_rows=artifact.count,
                 available_start=parent.start, available_end=parent.end)
    periods = [by_frame[frame] for frame in sorted(by_frame)]
    ready = sorted(available)
    return {**dataset_report(dataset, db.get(Instrument, dataset.instrument_id)), "maintenance": maintenance,
        "latest_version_id": published, "available_start": version.start if version else None,
        "available_end": version.end if version else None,
        "unknown_minutes": version.manifest.get("unknown_minutes") if version else None,
        "periods": periods, "usable_timeframes": ready,
        "availability": "available" if ready else "preparing" if maintenance.get("active_version_id") else "needs_maintenance"}


def dataset_list(db, *, query="", source=None, calendar=None, asset_class=None, status="all", page=1, page_size=25):
    if not 1 <= page_size <= 100 or page < 1 or status not in (
            "all", "available", "preparing", "attention", "paused", "archived"):
        raise ValueError("无效的列表范围或状态")
    # Registration also creates provider-only identities and mapping targets.
    # A saved maintenance plan is what makes an identity managed history.
    # Restrict before counting/paging, so directory rows cannot displace it.
    base = select(MarketDataset.id).join(Instrument).join(DatasetMaintenance)
    if query:
        # Literal substring search: user wildcards must not expand the query.
        base = base.where(code_search(query, MarketDataset.logical_symbol, Instrument.symbol))
    if source:
        base = base.where(Instrument.source == source)
    if calendar:
        base = base.where(Instrument.calendar == calendar)
    if asset_class:
        base = base.where(MarketDataset.asset_class == asset_class)
    if status == "archived":
        base = base.where(DatasetMaintenance.archived.is_(True))
    else:
        base = base.where(DatasetMaintenance.archived.is_(False))
    usable = select(HistoryVersion.id).join(HistoryArtifact).where(
        HistoryVersion.dataset_id == MarketDataset.id, HistoryVersion.status == "published",
        HistoryArtifact.status == "published", HistoryArtifact.count > 0).exists()
    if status == "available":
        base = base.where(usable)
    elif status == "preparing":
        base = base.where(DatasetMaintenance.active_version_id.is_not(None))
    elif status == "paused":
        base = base.where(DatasetMaintenance.paused.is_(True))
    elif status == "attention":
        failure = select(HistoryVersion.id).where(HistoryVersion.id == DatasetMaintenance.active_version_id,
            HistoryVersion.status.in_(("retrying", "configuration_error"))).exists()
        base = base.where(or_(~usable, failure))
    total = db.scalar(select(func.count()).select_from(base.subquery()))
    ids = db.scalars(base.order_by(MarketDataset.logical_symbol, Instrument.source,
        Instrument.calendar, MarketDataset.id).offset((page - 1) * page_size).limit(page_size))
    return {"items": [dataset_detail(db, ident) for ident in ids], "total": total,
            "page": page, "page_size": page_size}


def _task_query(*, dataset_id=None, query="", source=None, status="all"):
    if status not in ("all", "active", "attention", "history", "paused"):
        raise ValueError("无效的任务状态筛选")
    base = select(HistoryVersion.id).join(MarketDataset).join(Instrument).outerjoin(HistoryRun,
        HistoryRun.version_id == HistoryVersion.id)
    # SQL mirrors task_status before pagination, including published M1 with
    # unfinished period derivation and its requested pause/cancel state.
    state = case((
        (HistoryVersion.status == "published") & HistoryRun.version_id.is_not(None)
        & HistoryRun.completed_at.is_(None),
        case((HistoryRun.desired_state == "running", "deriving"), else_=HistoryRun.desired_state)
    ), else_=HistoryVersion.status)
    if dataset_id:
        base = base.where(HistoryVersion.dataset_id == dataset_id)
    if query:
        base = base.where(code_search(query, MarketDataset.logical_symbol, Instrument.symbol))
    if source:
        base = base.where(Instrument.source == source)
    groups = {"active": ("pending", "running", "deriving", "retrying", "configuration_error"),
              "attention": ("retrying", "configuration_error"),
              "history": ("published", "cancelled"), "paused": ("paused",)}
    if status != "all":
        base = base.where(state.in_(groups[status]))
    return base



def _task_report(db, ident):
    from .history_api import dataset_report
    from .history_versions import version_report

    report = version_report(db, ident)
    dataset = db.get(MarketDataset, report["dataset_id"])
    report["dataset"] = dataset_report(dataset, db.get(Instrument, dataset.instrument_id))
    report["version_status"] = report["status"]
    report["status"] = report["task_status"]
    report["controllable"] = db.get(HistoryRun, ident) is not None and report["status"] not in ("published", "cancelled")
    return report



def task_list(db, *, dataset_id=None, query="", source=None, status="all", page=1, page_size=25):
    if page < 1 or not 1 <= page_size <= 100:
        raise ValueError("无效的任务分页")
    base = _task_query(dataset_id=dataset_id, query=query, source=source, status=status)
    total = db.scalar(select(func.count()).select_from(base.subquery()))
    ids = db.scalars(base.order_by(HistoryVersion.created_at.desc(), HistoryVersion.id)
        .offset((page - 1) * page_size).limit(page_size))
    return {"items": [_task_report(db, ident) for ident in ids], "total": total,
            "page": page, "page_size": page_size}


def task_feed(db, *, dataset_id=None, query="", source=None, status="all", page_size=25,
              snapshot=None, before=None, ids=None):
    """Read-only keyset browsing; state polling never reorders already loaded rows."""
    from uuid import UUID

    from .storage import now_ms

    if not 1 <= page_size <= 100:
        raise ValueError("无效的任务分页")
    base = _task_query(dataset_id=dataset_id, query=query, source=source, status=status)
    if ids is not None:
        requested = list(dict.fromkeys(ids.split(",")))
        try:
            if not 1 <= len(requested) <= 100 or any(str(UUID(ident)) != ident for ident in requested):
                raise ValueError()
        except (ValueError, TypeError):
            raise ValueError("无效的任务身份") from None
        existing = set(db.scalars(select(HistoryVersion.id).where(HistoryVersion.id.in_(requested))))
        return {"items": [_task_report(db, ident) for ident in requested if ident in existing]}
    stamp = now_ms()
    if snapshot is None:
        # A closed millisecond boundary also puts same-millisecond insertions
        # into the new-record notice instead of ambiguously joining this feed.
        snapshot = max(0, stamp - 1)
    if not 0 <= snapshot <= stamp:
        raise ValueError("无效的任务快照")
    new_count = db.scalar(select(func.count()).select_from(
        base.where(HistoryVersion.created_at > snapshot).subquery()))
    base = base.where(HistoryVersion.created_at <= snapshot)
    total = db.scalar(select(func.count()).select_from(base.subquery()))
    if before:
        try:
            created, ident = before.split(":")
            created = int(created)
            if not 0 <= created <= snapshot or str(UUID(ident)) != ident:
                raise ValueError()
        except (ValueError, TypeError):
            raise ValueError("无效的任务游标") from None
        base = base.where(or_(HistoryVersion.created_at < created,
            (HistoryVersion.created_at == created) & (HistoryVersion.id > ident)))
    selected = list(db.scalars(base.order_by(HistoryVersion.created_at.desc(), HistoryVersion.id)
        .limit(page_size + 1)))
    items = selected[:page_size]
    last = db.get(HistoryVersion, items[-1]) if len(selected) > page_size else None
    return {"items": [_task_report(db, ident) for ident in items], "total": total,
        "snapshot": snapshot, "new_count": new_count,
        "next_cursor": f"{last.created_at}:{last.id}" if last else None}


def coverage_report(db, version_id, *, page=1, page_size=25):
    import json

    from .history_quality import classify
    from .source_history_store import raw_chunk
    from .storage import HistoryChunk, HistoryReclamation

    version = db.get(HistoryVersion, version_id)
    if not version or version.status != "published":
        raise ValueError("覆盖详情需要已发布历史版本")
    db.scalar(select(MarketDataset.id).where(MarketDataset.id == version.dataset_id)
              .with_for_update(read=True))
    if db.get(HistoryReclamation, version_id):
        raise ValueError("历史版本价格数据已回收；覆盖清单仍保留在发布记录中")
    if page < 1 or not 1 <= page_size <= 100:
        raise ValueError("无效的覆盖分页")
    query = select(HistoryChunk).where(HistoryChunk.version_id == version.id)
    total = db.scalar(select(func.count()).select_from(query.subquery()))
    items = []
    for chunk in db.scalars(query.order_by(HistoryChunk.start).offset((page - 1) * page_size).limit(page_size)):
        rows = json.loads(raw_chunk(db, chunk))
        items.append({"start": chunk.start, "end": chunk.end, "observed_at": chunk.observed_at,
            "result": chunk.result, **classify(version, rows, chunk.unknown)})
    return {"version_id": version.id, "items": items, "total": total, "page": page, "page_size": page_size}
