"""Source-isolated confirmed M1 heads and immutable price revisions.

SourceSeries is the cross-process write lock. The head watermark includes reads
which did not change prices, so delayed cache results cannot roll prices back.
"""

from decimal import Decimal

from sqlalchemy import select

from .source_history_store import _insert
from .source_registry import SourceIdentity, collection_identity
from .storage import SourceMinute, SourceMinuteRevision, SourceSeries, uid


def record(db, batch):
    source = collection_identity(batch.identity)
    if (not batch.result.successful or batch.checkpoint is None or
            not batch.window_start < batch.checkpoint <= batch.window_end or
            any(not row.complete or row.timestamp + 60000 > batch.checkpoint for row in batch.rows)):
        raise ValueError("Confirmed M1 needs a successful bounded source checkpoint")
    expected_volume = ("price_count", "quotes") if source.source == "oanda" else ("quantity", "source_quantity")
    if (batch.volume_kind, batch.volume_unit) != expected_volume:
        raise ValueError("Source M1 volume identity mismatch")
    db.execute(_insert(db)(SourceSeries).values(id=source.key, identity=source.model_dump())
        .on_conflict_do_nothing(index_elements=["id"]))
    series = db.scalar(select(SourceSeries).where(SourceSeries.id == source.key).with_for_update())
    if SourceIdentity.model_validate(series.identity) != source:
        raise ValueError("Confirmed source identity collision")
    current = {head.start: (head, revision) for head, revision in db.execute(
        select(SourceMinute, SourceMinuteRevision).join(
            SourceMinuteRevision, SourceMinute.revision_id == SourceMinuteRevision.id).where(
                SourceMinute.source_id == source.key, SourceMinute.start >= batch.window_start,
                SourceMinute.start < batch.window_end))}
    output, additions, updates = [], [], []
    for row in batch.rows:
        data = row.model_dump()
        for field in ("open", "high", "low", "close", "volume"):
            if data[field] is not None:
                data[field] = format(Decimal(data[field]).normalize(), "f")
        data.update(volume_kind=batch.volume_kind, volume_unit=batch.volume_unit)
        head, previous = current.get(row.timestamp, (None, None))
        stale = head is not None and head.last_observed_at > batch.observed_at
        changed = not stale and (previous is None or previous.data != data)
        revision = previous
        if changed:
            revision = SourceMinuteRevision(id=uid(), source_id=source.key, start=row.timestamp,
                data=data, observed_at=batch.observed_at)
            additions.append(revision)
        updates.append((head, row.timestamp, revision.id))
        output.append({"start": row.timestamp, "revision_id": revision.id,
                       "changed": changed, "stale": stale})
    # Persist all immutable revisions before writing FK head pointers. Two flushes
    # per batch rather than one flush (and reference checks) for every minute.
    db.add_all(additions)
    db.flush()
    for head, start, revision_id in updates:
        if head:
            head.revision_id = revision_id
            head.last_observed_at = max(head.last_observed_at, batch.observed_at)
        else:
            db.add(SourceMinute(source_id=source.key, start=start, revision_id=revision_id,
                                last_observed_at=batch.observed_at))
    db.flush()
    return {"source_id": source.key, "minutes": output}


def rows(db, source_id, start, end):
    query = select(SourceMinuteRevision).join(SourceMinute, SourceMinute.revision_id == SourceMinuteRevision.id).where(
        SourceMinute.source_id == source_id, SourceMinute.start >= start, SourceMinute.start < end).order_by(SourceMinute.start)
    for row in db.scalars(query.execution_options(yield_per=500)):
        yield {**row.data, "minute_revision_id": row.id, "observed_at": row.observed_at}
