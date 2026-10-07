"""Exact payload targets and conservative compressed-content accounting.

No price reads, deletion or demand. Shared blobs are counted once; payload byte
counts exclude database tuples/indexes/WAL and are not host-space guarantees.
"""

import hashlib
import json

from sqlalchemy import func, select

from .storage import (
    DatasetMaintenance,
    FixedIndicatorBlock,
    FixedIndicatorRun,
    HistoryArtifact,
    HistoryArtifactBlock,
    HistoryChunk,
    HistoryReclamation,
    HistoryVersion,
    Instrument,
    SourceBlob,
    SourceFetch,
)


def report(db, dataset, references):
    instrument = db.get(Instrument, dataset.instrument_id)
    versions = list(db.scalars(select(HistoryVersion).where(
        HistoryVersion.dataset_id == dataset.id).order_by(HistoryVersion.start, HistoryVersion.id)))
    version_ids = [v.id for v in versions]
    reclaimed = set(db.scalars(select(HistoryReclamation.version_id).where(
        HistoryReclamation.version_id.in_(version_ids))))
    target_ids = [v.id for v in versions if v.id not in reclaimed]
    artifacts = list(db.scalars(select(HistoryArtifact).where(
        HistoryArtifact.version_id.in_(version_ids)).order_by(HistoryArtifact.timeframe)))
    targets = [{"version_id": v.id, "start": v.start, "end": v.end,
        "published_at": v.published_at, "status": v.status,
        "observed_minutes": v.manifest.get("rows"),
        "unknown_minutes": v.manifest.get("unknown_minutes"),
        "payload_available": v.id not in reclaimed,
        "disposition": "already_reclaimed" if v.id in reclaimed else "protected" if
            references["items"] or references["requires_archive"] else "delete_payload",
        "periods": [{"timeframe": a.timeframe, "status": a.status, "rows": a.count}
                    for a in artifacts if a.version_id == v.id]} for v in versions]
    candidate_ids = select(HistoryChunk.content_id).where(
        HistoryChunk.version_id.in_(target_ids), HistoryChunk.content_id.is_not(None)).distinct()
    blobs = list(db.execute(select(SourceBlob.id, func.length(SourceBlob.content)).where(
        SourceBlob.id.in_(candidate_ids)).order_by(SourceBlob.id)))
    held_by_history = set(db.scalars(select(HistoryChunk.content_id).where(
        HistoryChunk.content_id.in_([b[0] for b in blobs]), HistoryChunk.version_id.notin_(target_ids))))
    held_by_cache = set(db.scalars(select(SourceFetch.content_id).where(
        SourceFetch.content_id.in_([b[0] for b in blobs]))))
    held = held_by_history | held_by_cache

    def payload_sum(model, predicate):
        return db.scalar(select(func.coalesce(func.sum(func.length(model.content)), 0)).where(predicate))

    artifact_ids = [a.id for a in artifacts if a.version_id in target_ids]
    run_ids = select(FixedIndicatorRun.id).where(FixedIndicatorRun.history_version_id.in_(target_ids))
    totals = {
        "target_versions": len(target_ids), "already_reclaimed_versions": len(reclaimed),
        "inline_m1_payload_bytes": payload_sum(HistoryChunk, HistoryChunk.version_id.in_(target_ids)),
        "period_payload_bytes": payload_sum(HistoryArtifactBlock, HistoryArtifactBlock.artifact_id.in_(artifact_ids)),
        "indicator_payload_bytes": payload_sum(FixedIndicatorBlock, FixedIndicatorBlock.run_id.in_(run_ids)),
        "unique_source_payload_bytes": sum(size for _, size in blobs),
        "retained_shared_source_blobs": len(held),
        "retained_shared_source_payload_bytes": sum(size for ident, size in blobs if ident in held),
        "currently_unreferenced_source_blobs": len(blobs) - len(held),
        "currently_unreferenced_source_payload_bytes": sum(size for ident, size in blobs if ident not in held),
    }
    plan = db.get(DatasetMaintenance, dataset.id)
    # Include exact payload/version/period targets and protective facts. Times
    # such as polling timestamps and next schedule do not invalidate a review.
    decision = {"dataset_id": dataset.id, "identity": dataset.identity,
        "versions": [(v.id, v.start, v.end, v.status, v.manifest.get("checksum"), v.id in reclaimed) for v in versions],
        "periods": [(a.id, a.status, a.count) for a in artifacts],
        "paused": bool(plan and plan.paused), "archived": bool(plan and plan.archived),
        "references": sorted((r["kind"], r["id"], r["detail"]) for r in references["items"])}
    return {"dataset": {"id": dataset.id, "logical_symbol": dataset.logical_symbol,
            "identity": dataset.identity, "aggregation_calendar": instrument.calendar},
        "versions": targets, "payload_totals": totals,
        "review_revision": hashlib.sha256(json.dumps(decision, sort_keys=True,
            separators=(",", ":")).encode()).hexdigest(),
        "space_meaning": "压缩内容字节为逻辑存储统计，排除表行、索引和WAL；共享内容按唯一块统计并保留其他引用。回收后数据库复用空间，不保证宿主磁盘等量减少。"}
