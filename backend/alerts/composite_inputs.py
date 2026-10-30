"""Pin source-confirmed revisions to composites with an append-only input log.

Every writer acquires the source lock before preparation locks. Current composite
heads allow indexed reads; immutable event deltas retain prior judgment inputs.
A changed input publishes its commit hint from this transaction, so the period
worker discovers the new revision instead of waiting for its next poll.
"""

import logging

from sqlalchemy import and_, func, or_, select

from .market_datasets import process_price_row
from .source_registry import collection_identity
from .storage import (
    CompositeInputEvent,
    CompositeMinute,
    CompositeMinuteInput,
    CompositePreparation,
    CompositeRevision,
    Instrument,
    MarketDataset,
    Preference,
    RealtimeMapping,
    SourceMinuteRevision,
    uid,
)

log = logging.getLogger(__name__)


def _wake_aggregation(db):
    """Publish this transaction's input hint without letting it fail the input.

    The hint is advisory: PostgreSQL delivers it only if this transaction commits,
    so a rolled-back confirmation never wakes a worker and the durable task
    waterline stays the source of truth. The savepoint contains a failed hint
    (aborted statement or lost connection) so confirmed minutes this transaction
    already holds are still committed.
    """
    from .publication_wakeup import notify

    # Flush first: the savepoint may only discard the hint, never input rows this
    # transaction already decided to write.
    db.flush()
    try:
        with db.begin_nested():
            notify(db)
    except Exception as error:
        log.warning("composite_input_wakeup_failed type=%s", type(error).__name__)


def frozen(prep):
    """A superseded revision keeps its waterline and accepts no new input."""
    return bool(prep is not None and prep.state.get("revision_frozen"))


def unfrozen():
    """Live fan-out and aggregate claim skip frozen revisions; missing means live."""
    return CompositePreparation.state["revision_frozen"].as_boolean().is_not(True)


def apply_minutes(db, recorded, *, revision_id=None, reason="live_confirmation"):
    if not recorded["minutes"]:
        return []
    from .live_window import require_window

    require_window(min(item["start"] for item in recorded["minutes"]))
    query = select(CompositeRevision, MarketDataset).join(
        RealtimeMapping, CompositeRevision.mapping_id == RealtimeMapping.id).join(
        MarketDataset, RealtimeMapping.target_dataset_id == MarketDataset.id).join(
        CompositePreparation, CompositePreparation.revision_id == CompositeRevision.id).where(
        unfrozen())
    if revision_id:
        query = query.where(CompositeRevision.id == revision_id)
    output = []
    for revision, dataset in db.execute(query.order_by(CompositeRevision.id)):
        if collection_identity(dataset.identity).key != recorded["source_id"]:
            continue
        if reason == "live_confirmation":
            from .realtime_switch import revision_instrument_id

            # Explicit off stops live fan-out even when another consumer keeps
            # the shared source alive. Preparation/recheck remains historical.
            source_id = revision_instrument_id(db, revision)
            choice = db.get(Preference, "managed_realtime:" + source_id) if source_id else None
            if choice and choice.value.get("enabled") is False:
                continue
        selected = [item for item in recorded["minutes"] if item["start"] >= revision.seam]
        if not selected:
            continue
        prep = db.scalar(select(CompositePreparation).where(
            CompositePreparation.revision_id == revision.id).with_for_update())
        if not prep:
            raise ValueError("Composite preparation missing")
        if frozen(prep):
            continue  # The switched-away revision keeps its fixed waterline.
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
    from .display_observations import retire_confirmed

    retire_confirmed(db, recorded['source_id'], [item['start'] for item in recorded['minutes']])
    if output:
        # Only a changed input can make a period task due; an unchanged
        # confirmation would wake the worker for an empty scan. The hint rides
        # this transaction, so it is delivered only if the input commits.
        _wake_aggregation(db)
    return output


def rows(db, revision_id, start, end, *, input_revision=None, now=None):
    """Bounded immutable input reconstruction, indexed by revision/minute/version."""
    prep = db.get(CompositePreparation, revision_id)
    if not prep:
        raise ValueError("Composite preparation missing")
    value = prep.input_revision if input_revision is None else input_revision
    if not 0 <= value <= prep.input_revision or start >= end:
        raise ValueError("Invalid composite input revision/window")
    from .live_window import lower_bound

    start = max(start, lower_bound(now))
    if start >= end:
        return
    revision = db.get(CompositeRevision, revision_id)
    mapping = db.get(RealtimeMapping, revision.mapping_id)
    dataset = db.get(MarketDataset, mapping.target_dataset_id)
    instrument = db.get(Instrument, dataset.instrument_id)
    latest = select(CompositeMinuteInput.start, func.max(CompositeMinuteInput.input_revision).label("latest")).where(
        CompositeMinuteInput.revision_id == revision_id, CompositeMinuteInput.start >= start,
        CompositeMinuteInput.start < end, CompositeMinuteInput.input_revision <= value
    ).group_by(CompositeMinuteInput.start).subquery()
    query = select(SourceMinuteRevision).join(CompositeMinuteInput,
        CompositeMinuteInput.source_revision_id == SourceMinuteRevision.id).join(latest, and_(
            CompositeMinuteInput.start == latest.c.start, CompositeMinuteInput.input_revision == latest.c.latest)
        ).where(CompositeMinuteInput.revision_id == revision_id).order_by(CompositeMinuteInput.start)
    for row in db.scalars(query.execution_options(yield_per=500)):
        data = process_price_row(row.data, instrument.precision)
        yield {**data, "minute_revision_id": row.id, "source_id": row.source_id,
               "observed_at": row.observed_at}


def confirmation_watermark(db, revision_id, start, end, input_revision, *, previous=None):
    """Latest immutable minute inputs in the exact recursive dependency prefix."""
    query = select(CompositeMinuteInput.start, func.max(CompositeMinuteInput.input_revision).label("latest")).where(
        CompositeMinuteInput.revision_id == revision_id, CompositeMinuteInput.start >= start,
        CompositeMinuteInput.start < end, CompositeMinuteInput.input_revision <= input_revision
    )
    watermark = 0
    if previous:
        old_revision, old_value, old_start, old_end = previous["key"]
        if old_revision == revision_id and old_start == start and old_end <= end and old_value <= input_revision:
            # Read only added time buckets or immutable revisions since the
            # previous proof. Unchanged minute prefixes need no payload scan.
            query = query.where(or_(CompositeMinuteInput.start >= old_end,
                                    CompositeMinuteInput.input_revision > old_value))
            watermark = previous["watermark"]
    latest = query.group_by(CompositeMinuteInput.start).subquery()
    observed = db.scalar(select(func.max(SourceMinuteRevision.observed_at)).join(CompositeMinuteInput,
        CompositeMinuteInput.source_revision_id == SourceMinuteRevision.id).join(latest, and_(
            CompositeMinuteInput.start == latest.c.start, CompositeMinuteInput.input_revision == latest.c.latest)
        ).where(CompositeMinuteInput.revision_id == revision_id)) or 0
    return max(watermark, observed)
