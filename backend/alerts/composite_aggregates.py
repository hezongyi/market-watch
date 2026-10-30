"""Incremental persisted buckets behind fixed composite reads.

Source writers never acquire task locks. Workers serialize per revision/period,
process immutable events in order, and publish a waterline only after all affected
buckets have committed. Each tick reads a bounded partition, outside task locks.
"""

import copy

from sqlalchemy import and_, func, select

from .chart_data import FRAMES
from .composite_inputs import frozen, unfrozen
from .composite_series import period, read_window
from .source_history_store import _insert
from .storage import (
    CompositeAggregateBar,
    CompositeAggregateTask,
    CompositeInputEvent,
    CompositePreparation,
    CompositeRevision,
    HistoryVersion,
    MarketComposite,
    MarketDataset,
    Preference,
    now_ms,
    transaction,
    uid,
)

MAX_BUCKETS = 128


class Fenced(TimeoutError):
    """A switched-away revision refuses late aggregates; nothing is written."""


def request(db, revision_id):
    for frame in FRAMES:
        db.execute(_insert(db)(CompositeAggregateTask).values(revision_id=revision_id,
            timeframe=frame, applied_input_revision=-1, offset=0, lease_until=0,
            next_at=0, attempts=0, updated_at=now_ms()).on_conflict_do_nothing(
                index_elements=["revision_id", "timeframe"]))


def runtime_revisions():
    return select(CompositeRevision.id).join(HistoryVersion,
            HistoryVersion.id == CompositeRevision.history_version_id).join(MarketDataset,
            MarketDataset.id == HistoryVersion.dataset_id).join(Preference,
            Preference.key == "managed_realtime:" + MarketDataset.instrument_id).where(
                Preference.value["enabled"].as_boolean().is_(True))


def runtime_error():
    """Keep a failed period visible while other periods continue or retry."""
    with transaction() as db:
        return db.scalar(select(CompositeAggregateTask.error).where(
            CompositeAggregateTask.revision_id.in_(runtime_revisions()),
            CompositeAggregateTask.error.is_not(None)).order_by(
                CompositeAggregateTask.revision_id, CompositeAggregateTask.timeframe).limit(1))


def claim(revision_id=None, timeframe=None, *, runtime_only=False):
    with transaction() as db:
        eligible = runtime_revisions()
        # Backfill tasks for pre-upgrade composites without touching definitions
        # or creating chart/source demand. Each scan registers at most 20 revisions.
        missing = select(CompositeRevision.id).join(
            CompositePreparation, CompositePreparation.revision_id == CompositeRevision.id).where(
            unfrozen(), ~select(CompositeAggregateTask.revision_id).where(
                CompositeAggregateTask.revision_id == CompositeRevision.id).exists())
        if runtime_only:
            missing = missing.where(CompositeRevision.id.in_(eligible))
        missing = missing.limit(20)
        for ident in db.scalars(missing):
            request(db, ident)
        stamp = now_ms()
        query = select(CompositeAggregateTask).join(CompositePreparation,
            CompositeAggregateTask.revision_id == CompositePreparation.revision_id).where(
                unfrozen(),
                CompositeAggregateTask.applied_input_revision < CompositePreparation.input_revision,
                CompositeAggregateTask.lease_until <= stamp, CompositeAggregateTask.next_at <= stamp)
        if revision_id:
            query = query.where(CompositeAggregateTask.revision_id == revision_id)
        if timeframe:
            query = query.where(CompositeAggregateTask.timeframe == timeframe)
        if runtime_only:
            query = query.where(CompositeAggregateTask.revision_id.in_(eligible))
        task = db.scalar(query.order_by(CompositeAggregateTask.updated_at,
            CompositeAggregateTask.revision_id, CompositeAggregateTask.timeframe)
            .with_for_update(skip_locked=True, of=CompositeAggregateTask).limit(1))
        if not task:
            return None
        revision = db.get(CompositeRevision, task.revision_id)
        value = task.applied_input_revision + 1
        if value == 0:
            buckets = [period(revision.seam, task.timeframe, revision.rules["aggregation_calendar"])]
        else:
            event = db.scalar(select(CompositeInputEvent).where(CompositeInputEvent.revision_id == revision.id,
                CompositeInputEvent.input_revision == value))
            if event is None:
                raise ValueError("Missing immutable composite input event")
            buckets = sorted({period(item["start"], task.timeframe, revision.rules["aggregation_calendar"])
                              for item in event.input_manifest["minutes"]})
        selected = []
        for pair in buckets[task.offset:task.offset + MAX_BUCKETS]:
            if selected and pair[1] - selected[0][0] > 32 * 86400000:
                break
            selected.append(pair)
        if not selected:
            raise ValueError("Composite aggregate checkpoint beyond event buckets")
        task.lease_token, task.lease_until = uid(), stamp + 60000
        task.updated_at = stamp
        return {"revision_id": revision.id, "composite_id": revision.composite_id,
            "permission_scope": db.get(MarketComposite, revision.composite_id).permission_scope,
            "timeframe": task.timeframe, "input_revision": value, "offset": task.offset,
            "token": task.lease_token, "buckets": selected, "total": len(buckets)}


def build(ownership):
    with transaction() as db:
        # Inputs are immutable; reading while new confirmations arrive cannot
        # move this task's selected version or its fixed historical parent.
        return read_window(db, ownership["composite_id"], ownership["timeframe"],
            ownership["buckets"][0][0], ownership["buckets"][-1][1],
            revision_id=ownership["revision_id"], input_revision=ownership["input_revision"],
            provisional=False, permission_scope=ownership["permission_scope"])["bars"]


def _lock(db, ownership):
    if frozen(db.get(CompositePreparation, ownership["revision_id"])):
        raise Fenced("组合修订已冻结，迟到聚合提交被拒绝")
    task = db.scalar(select(CompositeAggregateTask).where(
        CompositeAggregateTask.revision_id == ownership["revision_id"],
        CompositeAggregateTask.timeframe == ownership["timeframe"]).with_for_update())
    if (not task or task.lease_token != ownership["token"] or task.lease_until <= now_ms()
            or task.applied_input_revision + 1 != ownership["input_revision"] or task.offset != ownership["offset"]):
        raise TimeoutError("Composite aggregation ownership expired or superseded")
    return task


def commit(ownership, bars):
    starts = {pair[0] for pair in ownership["buckets"]}
    with transaction() as db:
        task = _lock(db, ownership)
        for bar in bars:
            if bar["start"] not in starts:
                continue  # Intervening unchanged buckets retain their versions.
            if (bar["composite_revision_id"] != ownership["revision_id"] or
                    bar["input_revision"] != ownership["input_revision"] or not bar["source_confirmed"]):
                raise ValueError("Aggregate output does not match the fixed confirmed input")
            db.add(CompositeAggregateBar(revision_id=task.revision_id, timeframe=task.timeframe,
                start=bar["start"], input_revision=ownership["input_revision"], data=bar))
        task.offset += len(starts)
        if task.offset == ownership["total"]:
            task.applied_input_revision, task.offset = ownership["input_revision"], 0
            # The transaction that moves this waterline is the one that makes
            # the new input judgeable, so it is the one that wakes the rules.
            from .publication_wakeup import notify
            notify(db)
        task.lease_token, task.lease_until, task.next_at, task.attempts, task.error = None, 0, 0, 0, None
        task.updated_at = now_ms()


def aggregate_tick(revision_id=None, timeframe=None, *, on_error=None, runtime_only=False):
    ownership = claim(revision_id, timeframe, runtime_only=runtime_only)
    if not ownership:
        return False
    try:
        commit(ownership, build(ownership))
    except Exception as error:
        if on_error:
            on_error(type(error).__name__)
        with transaction() as db:
            try:
                task = _lock(db, ownership)
            except TimeoutError:
                return True
            task.attempts += 1
            task.error = type(error).__name__
            task.next_at = now_ms() + min(60000, 1000 * 2 ** min(task.attempts, 6))
            task.lease_token, task.lease_until = None, 0
    return True


def read(db, revision_id, frame, input_revision, *, before, count, now, after=None, newest_first=True):
    """None means still preparing; [] means a fully processed empty tail."""
    task = db.get(CompositeAggregateTask, (revision_id, frame))
    if not task or task.applied_input_revision < input_revision:
        return None
    latest_query = select(CompositeAggregateBar.start, func.max(CompositeAggregateBar.input_revision).label("latest")).where(
        CompositeAggregateBar.revision_id == revision_id, CompositeAggregateBar.timeframe == frame,
        CompositeAggregateBar.input_revision <= input_revision, CompositeAggregateBar.start < before
    )
    from .live_window import lower_bound

    # A seam bucket may contain fixed history; reject a materialized mixed
    # bucket whose live portion crossed the boundary and rebuild from inputs.
    revision = db.get(CompositeRevision, revision_id)
    floor = lower_bound(now)
    if revision.seam < floor:
        return None
    if after is not None:
        latest_query = latest_query.where(CompositeAggregateBar.start >= after)
    latest = latest_query.group_by(CompositeAggregateBar.start).subquery()
    query = select(CompositeAggregateBar).join(latest, and_(
        CompositeAggregateBar.start == latest.c.start, CompositeAggregateBar.input_revision == latest.c.latest)).where(
            CompositeAggregateBar.revision_id == revision_id, CompositeAggregateBar.timeframe == frame)
    output = []
    ordering = CompositeAggregateBar.start.desc() if newest_first else CompositeAggregateBar.start
    selected = list(db.scalars(query.order_by(ordering).limit(count)))
    for row in reversed(selected) if newest_first else selected:
        bar = copy.deepcopy(row.data)
        bar["input_revision"] = input_revision
        bar["time_closed"] = bar["end"] <= now
        bar["complete"] = bar["time_closed"] and bar["source_confirmed"] and bar["coverage_complete"]
        bar["volume_complete"] = bar["complete"] and bar["volume"] is not None
        for segment in bar["segments"]:
            if segment["segment"] == "target":
                segment["input"]["input_revision"] = input_revision
        output.append(bar)
    return output


def report(db, revision_id, input_revision):
    tasks = {task.timeframe: task for task in db.scalars(select(CompositeAggregateTask).where(
        CompositeAggregateTask.revision_id == revision_id))}
    stamp = now_ms()
    return [{"timeframe": frame, "status": "pending" if frame not in tasks else
        "caught_up" if tasks[frame].applied_input_revision >= input_revision else
        "retrying" if tasks[frame].error else "building",
        "applied_input_revision": tasks[frame].applied_input_revision if frame in tasks else -1,
        "input_revision": input_revision, "offset": tasks[frame].offset if frame in tasks else 0,
        "working": bool(frame in tasks and tasks[frame].lease_token and tasks[frame].lease_until > stamp),
        "error": tasks[frame].error if frame in tasks else None,
        "next_at": tasks[frame].next_at if frame in tasks else 0,
        "updated_at": tasks[frame].updated_at if frame in tasks else None} for frame in FRAMES]
