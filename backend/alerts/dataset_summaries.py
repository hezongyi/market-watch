"""Bounded management rows, without per-row history or runtime detail queries."""

import re

from sqlalchemy import func, select

from .data_center import _dataset_query
from .history_api import dataset_report
from .storage import (
    DatasetMaintenance,
    HistoryArtifact,
    HistoryArtifactBlock,
    HistoryReclamation,
    HistoryVersion,
    Instrument,
    MarketComposite,
    MarketDataset,
    Preference,
    RealtimeMapping,
)


def summaries(db, *, ids=None, view=None, anchor=None, **filters):
    base = _dataset_query(**filters)
    if view == "continuation":
        base = base.where(select(RealtimeMapping.id).where(
            RealtimeMapping.dataset_id == MarketDataset.id,
            RealtimeMapping.permission_scope == "workspace:default").exists())
    elif view not in (None, ""):
        raise ValueError("无效的自建行情视图")
    requested = None
    if ids is not None:
        requested = list(dict.fromkeys(ids.split(",")))
        if not 1 <= len(requested) <= 100 or any(not re.fullmatch("[a-f0-9]{64}", item) for item in requested):
            raise ValueError("无效的数据集批量范围")
    total = db.scalar(select(func.count()).select_from(base.subquery()))
    ordering = (MarketDataset.logical_symbol, Instrument.source, Instrument.calendar, MarketDataset.id)
    ranked = base.add_columns(func.row_number().over(order_by=ordering).label("position")).subquery()
    anchor_position = None
    if anchor is not None:
        if not re.fullmatch(r"(?:dataset|composite)-[a-f0-9]{64}", anchor):
            raise ValueError("无效的列表定位目标")
        kind, ident = anchor.split("-", 1)
        dataset_id = ident if kind == "dataset" else select(MarketComposite.dataset_id).where(
            MarketComposite.id == ident, MarketComposite.permission_scope == "workspace:default").scalar_subquery()
        anchor_position = db.scalar(select(ranked.c.position).where(ranked.c.id == dataset_id))
    query = select(MarketDataset, Instrument, DatasetMaintenance, ranked.c.position).join(
        Instrument).join(DatasetMaintenance).join(ranked, ranked.c.id == MarketDataset.id)
    if requested is not None:
        query = query.where(MarketDataset.id.in_(requested))
    else:
        size, page = filters.get("page_size", 25), filters.get("page", 1)
        query = query.where(ranked.c.position > (page - 1) * size, ranked.c.position <= page * size)
    selected = db.execute(query.order_by(ranked.c.position)).all()
    items = _rows(db, selected)
    return {"items": items, "total": total, "page": filters.get("page", 1),
            "page_size": filters.get("page_size", 25), "anchor_position": anchor_position}


def _rows(db, selected):
    if not selected:
        return []
    ids = [dataset.id for dataset, *_ in selected]
    latest_rank = select(HistoryVersion.id, func.row_number().over(
        partition_by=HistoryVersion.dataset_id,
        order_by=(HistoryVersion.end.desc(), HistoryVersion.published_at.desc(), HistoryVersion.id)
    ).label("position")).where(HistoryVersion.dataset_id.in_(ids), HistoryVersion.status == "published",
        ~select(HistoryReclamation.version_id).where(HistoryReclamation.version_id == HistoryVersion.id).exists()).subquery()
    latest = {row.dataset_id: row for row in db.scalars(select(HistoryVersion).join(
        latest_rank, latest_rank.c.id == HistoryVersion.id).where(latest_rank.c.position == 1))}
    artifacts_rank = select(HistoryArtifact.id, func.row_number().over(
        partition_by=(HistoryVersion.dataset_id, HistoryArtifact.timeframe),
        order_by=(HistoryVersion.end.desc(), HistoryVersion.published_at.desc(), HistoryArtifact.id)
    ).label("position")).join(HistoryVersion).where(HistoryVersion.dataset_id.in_(ids),
        HistoryVersion.status == "published", HistoryArtifact.status == "published",
        HistoryArtifact.count > 0).subquery()
    artifacts = list(db.scalars(select(HistoryArtifact).join(artifacts_rank,
        artifacts_rank.c.id == HistoryArtifact.id).where(artifacts_rank.c.position == 1)))
    version_ids = {value for _, _, plan, _ in selected
                   for value in (plan.latest_version_id, plan.active_version_id) if value}
    version_ids.update(artifact.version_id for artifact in artifacts)
    versions = {row.id: row for row in latest.values()}
    missing = version_ids - versions.keys()
    if missing:
        versions.update((row.id, row) for row in db.scalars(select(HistoryVersion).where(HistoryVersion.id.in_(missing))))
    bounds = {ident: (start, end) for ident, start, end in db.execute(select(
        HistoryArtifactBlock.artifact_id, func.min(HistoryArtifactBlock.start), func.max(HistoryArtifactBlock.end)
    ).where(HistoryArtifactBlock.artifact_id.in_([item.id for item in artifacts])).group_by(HistoryArtifactBlock.artifact_id))}
    periods = {ident: [] for ident in ids}
    for artifact in artifacts:
        parent = versions[artifact.version_id]
        dataset = next(item for item, *_ in selected if item.id == parent.dataset_id)
        start, end = bounds.get(artifact.id, (parent.start, parent.end)) if dataset.identity.get("identity_version") == 2 else (parent.start, parent.end)
        periods[parent.dataset_id].append({"id": artifact.id, "timeframe": artifact.timeframe,
            "status": "published", "rows": artifact.count, "complete_rows": artifact.complete_count,
            "available_version_id": parent.id, "available_start": start, "available_end": end})
    switches = {row.key: row.value for row in db.scalars(select(Preference).where(
        Preference.key.in_(["managed_realtime:" + inst.id for _, inst, _, _ in selected])))}
    from .continuation_summaries import summaries as continuation_summaries

    continuations = continuation_summaries(db, [dataset for dataset, *_ in selected], switches)
    output = []
    for dataset, inst, plan, position in selected:
        parent = versions.get(plan.latest_version_id) if plan.latest_version_id else latest.get(dataset.id)
        active = versions.get(plan.active_version_id)
        ready = sorted(periods[dataset.id], key=lambda item: item["timeframe"])
        maintenance = {key: getattr(plan, key) for key in (
            "frequency", "paused", "archived", "last_attempt", "last_success", "active_version_id")}
        maintenance.update(configured=True, task_error=active.error if active else None,
            next_at=plan.next_at if plan.frequency == "daily" and not plan.paused and not plan.archived else None)
        output.append({**dataset_report(dataset, inst), "position": position, "maintenance": maintenance,
            "latest_version_id": parent.id if parent else None, "available_start": parent.start if parent else None,
            "available_end": parent.end if parent else None,
            "unknown_minutes": parent.manifest.get("unknown_minutes") if parent else None,
            "usable_timeframes": [item["timeframe"] for item in ready], "periods": ready,
            "availability": "available" if ready else "preparing" if active else "needs_maintenance",
            "continuation": continuations[dataset.id]})
    return output
