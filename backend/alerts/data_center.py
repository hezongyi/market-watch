"""Pure management queries shared by desktop UI and authenticated callers."""

from sqlalchemy import func, or_, select

from .history_maintenance import plan_report
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
    base = select(MarketDataset.id).join(Instrument).outerjoin(DatasetMaintenance)
    if query:
        # Literal substring search: user wildcards must not expand the query.
        value = "%" + query[:100].replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        base = base.where(or_(MarketDataset.logical_symbol.ilike(value, escape="\\"),
                             Instrument.symbol.ilike(value, escape="\\")))
    if source:
        base = base.where(Instrument.source == source)
    if calendar:
        base = base.where(Instrument.calendar == calendar)
    if asset_class:
        base = base.where(MarketDataset.asset_class == asset_class)
    if status == "archived":
        base = base.where(DatasetMaintenance.archived.is_(True))
    else:
        base = base.where(or_(DatasetMaintenance.archived.is_(False), DatasetMaintenance.dataset_id.is_(None)))
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


def task_list(db, *, dataset_id=None, page=1, page_size=25):
    from .history_api import dataset_report
    from .history_versions import version_report

    if page < 1 or not 1 <= page_size <= 100:
        raise ValueError("无效的任务分页")
    query = select(HistoryVersion.id)
    if dataset_id:
        query = query.where(HistoryVersion.dataset_id == dataset_id)
    total = db.scalar(select(func.count()).select_from(query.subquery()))
    items = []
    for ident in db.scalars(query.order_by(HistoryVersion.created_at.desc(), HistoryVersion.id)
                           .offset((page - 1) * page_size).limit(page_size)):
        report = version_report(db, ident)
        dataset = db.get(MarketDataset, report["dataset_id"])
        report["dataset"] = dataset_report(dataset, db.get(Instrument, dataset.instrument_id))
        report["version_status"] = report["status"]
        report["status"] = report["task_status"]
        report["controllable"] = db.get(HistoryRun, ident) is not None and report["status"] not in ("published", "cancelled")
        items.append(report)
    return {"items": items, "total": total, "page": page, "page_size": page_size}


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
