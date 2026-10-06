"""Pin source-confirmed revisions to composites with an append-only input log.

Every writer acquires the source lock before preparation locks. Current composite
heads allow indexed reads; immutable event deltas retain prior judgment inputs.
"""

from sqlalchemy import and_, func, select

from .source_registry import collection_identity
from .storage import (
    CompositeInputEvent,
    CompositeMinute,
    CompositeMinuteInput,
    CompositePreparation,
    CompositeRevision,
    MarketDataset,
    RealtimeMapping,
    SourceMinuteRevision,
    uid,
)


def apply_minutes(db, recorded, *, revision_id=None, reason="live_confirmation"):
    if not recorded["minutes"]:
        return []
    query = select(CompositeRevision, MarketDataset).join(
        RealtimeMapping, CompositeRevision.mapping_id == RealtimeMapping.id).join(
        MarketDataset, RealtimeMapping.target_dataset_id == MarketDataset.id)
    if revision_id:
        query = query.where(CompositeRevision.id == revision_id)
    output = []
    for revision, dataset in db.execute(query.order_by(CompositeRevision.id)):
        if collection_identity(dataset.identity).key != recorded["source_id"]:
            continue
        selected = [item for item in recorded["minutes"] if item["start"] >= revision.seam]
        if not selected:
            continue
        prep = db.scalar(select(CompositePreparation).where(
            CompositePreparation.revision_id == revision.id).with_for_update())
        if not prep:
            raise ValueError("Composite preparation missing")
        current = {row.start: row for row in db.scalars(select(CompositeMinute).where(
            CompositeMinute.revision_id == revision.id,
            CompositeMinute.start >= selected[0]["start"],
            CompositeMinute.start <= selected[-1]["start"]))}
        changes = []
        for item in selected:
            head = current.get(item["start"])
            if head and head.source_revision_id == item["revision_id"]:
                continue
            changes.append({"start": item["start"], "source_revision_id": item["revision_id"],
                            "previous_source_revision_id": head.source_revision_id if head else None})
            if head:
                head.source_revision_id = item["revision_id"]
            else:
                db.add(CompositeMinute(revision_id=revision.id, start=item["start"],
                                       source_revision_id=item["revision_id"]))
        if changes:
            prep.input_revision += 1
            prep.confirmed_end = max(prep.confirmed_end, max(item["start"] for item in selected) + 60000)
            event_id = uid()
            db.add(CompositeInputEvent(id=event_id, revision_id=revision.id, input_revision=prep.input_revision,
                input_manifest={"schema": 1, "reason": reason, "source_id": recorded["source_id"],
                                "minutes": changes}))
            db.flush()
            db.add_all([CompositeMinuteInput(revision_id=revision.id, start=item["start"],
                input_revision=prep.input_revision, event_id=event_id,
                source_revision_id=item["source_revision_id"]) for item in changes])
            output.append({"revision_id": revision.id, "input_revision": prep.input_revision,
                           "changed_minutes": len(changes)})
    db.flush()
    return output


def rows(db, revision_id, start, end, *, input_revision=None):
    """Bounded immutable input reconstruction, indexed by revision/minute/version."""
    prep = db.get(CompositePreparation, revision_id)
    if not prep:
        raise ValueError("Composite preparation missing")
    value = prep.input_revision if input_revision is None else input_revision
    if not 0 <= value <= prep.input_revision or start >= end:
        raise ValueError("Invalid composite input revision/window")
    latest = select(CompositeMinuteInput.start, func.max(CompositeMinuteInput.input_revision).label("latest")).where(
        CompositeMinuteInput.revision_id == revision_id, CompositeMinuteInput.start >= start,
        CompositeMinuteInput.start < end, CompositeMinuteInput.input_revision <= value
    ).group_by(CompositeMinuteInput.start).subquery()
    query = select(SourceMinuteRevision).join(CompositeMinuteInput,
        CompositeMinuteInput.source_revision_id == SourceMinuteRevision.id).join(latest, and_(
            CompositeMinuteInput.start == latest.c.start, CompositeMinuteInput.input_revision == latest.c.latest)
        ).where(CompositeMinuteInput.revision_id == revision_id).order_by(CompositeMinuteInput.start)
    for row in db.scalars(query.execution_options(yield_per=500)):
        yield {**row.data, "minute_revision_id": row.id, "source_id": row.source_id,
               "observed_at": row.observed_at}
