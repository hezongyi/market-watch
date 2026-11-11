"""One compact source fact: queried intervals and unresolved query failures.

This does not certify missing prices or alter chart coverage. Successful bounded
M1 checkpoints establish query coverage; failures remain until a newer successful
query covers them. The existing SourceSeries lock serializes updates with prices.
"""

from sqlalchemy import select

from .source_history_store import _insert
from .source_registry import collection_identity
from .storage import Preference, SourceSeries


def _union(intervals):
    merged = []
    for start, end in sorted(intervals):
        if start >= end:
            continue
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(end, merged[-1][1])
        else:
            merged.append([start, end])
    return merged


def _subtract(start, end, lower, upper):
    return [[start, min(end, lower)], [max(start, upper), end]] if lower < end and upper > start else [[start, end]]


def lock_source(db, identity):
    source = collection_identity(identity)
    db.execute(_insert(db)(SourceSeries).values(id=source.key, identity=source.model_dump())
        .on_conflict_do_nothing(index_elements=["id"]))
    db.scalar(select(SourceSeries).where(SourceSeries.id == source.key).with_for_update())
    return source


def record(db, batch):
    source = collection_identity(batch.identity)
    if source.source != "oanda":
        return
    successful = batch.result.successful
    if successful and batch.checkpoint is None:
        return  # Legacy empty responses are not bounded query proofs.
    end = batch.checkpoint if successful else batch.window_end
    if not batch.window_start < end <= batch.window_end:
        raise ValueError("Invalid confirmation query checkpoint")
    lock_source(db, batch.identity)
    key = "price_confirmation:v1:" + source.key
    row = db.get(Preference, key, populate_existing=True)
    previous = dict(row.value) if row else {}
    stamp = max(previous.get("observed_at", 0), batch.observed_at)
    from .live_window import lower_bound

    floor = lower_bound(stamp)
    intervals = [[max(start, floor), end] for start, end in previous.get("queried", []) if end > floor]
    # A discarded unresolved failure must not turn an old materialization into
    # proof. Retain a compact conservative envelope outside the readable window.
    expired = previous.get("unreadable_failure")
    expired_spans = ([expired] if expired else []) + [
        [item[0], min(item[1], floor)] for item in previous.get("failures", []) if item[0] < floor]
    expired = [min(item[0] for item in expired_spans), max(item[1] for item in expired_spans)] if expired_spans else None
    failures = [[max(item[0], floor), *item[1:]] for item in previous.get("failures", []) if item[1] > floor]
    if successful:
        intervals.append([max(batch.window_start, floor), end])
        retained = []
        for start, stop, at, reason in failures:
            pieces = (_subtract(start, stop, batch.window_start, end) if at <= batch.observed_at
                      else [[start, stop]])
            retained.extend([max(a, floor), b, at, reason] for a, b in pieces if max(a, floor) < b)
        failures = retained
    else:
        # Repeated failures of the same/smaller interval do not grow the fact.
        failures = [item for item in failures if not (
            batch.window_start <= item[0] and item[1] <= end and item[2] <= batch.observed_at)]
        if end > floor:
            failures.append([max(batch.window_start, floor), end, batch.observed_at, batch.result.status])
        else:
            expired = [min(expired[0], batch.window_start) if expired else batch.window_start,
                max(expired[1], end) if expired else end]
    value = {"queried": _union(intervals), "failures": failures, "observed_at": stamp,
        "unreadable_failure": expired}
    if row:
        row.value = value
    else:
        db.add(Preference(key=key, value=value))


def facts(db, identity):
    row = db.get(Preference, "price_confirmation:v1:" + collection_identity(identity).key)
    return dict(row.value) if row else {}


def covered(fact, start, end):
    return any(lower <= start and end <= upper for lower, upper in fact.get("queried", []))


def failure(fact, start, end):
    return next((reason for lower, upper, _, reason in fact.get("failures", [])
                 if lower < end and start < upper), None)
