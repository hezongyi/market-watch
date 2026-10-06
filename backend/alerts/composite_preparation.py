"""Durable bounded M1 catch-up for fixed composite revisions.

The query cutoff never moves. Completing queries does not certify coverage or
strategy readiness. Supplier I/O and shared acquisition occur outside DB locks.
"""

import hashlib

from sqlalchemy import select

from .composite_inputs import apply_minutes
from .confirmed_minutes import record
from .history_sources import HistoryConfigurationError, page_end
from .market_contracts import DatasetIdentity, MarketRequestError, failed_request
from .market_resources import lane
from .source_history_store import AcquisitionBusy, shared_page
from .storage import (
    CompositePreparation,
    CompositeReadAttempt,
    CompositeRevision,
    Instrument,
    MarketDataset,
    RealtimeMapping,
    now_ms,
    transaction,
    uid,
)


def read_id(token):
    return hashlib.sha256(("composite-read:" + token).encode()).hexdigest()[:36]


def claim(revision_id=None):
    with transaction() as db:
        stamp = now_ms()
        query = select(CompositePreparation).where(
            CompositePreparation.status.in_(("pending", "running", "retrying")),
            CompositePreparation.lease_until <= stamp, CompositePreparation.next_at <= stamp)
        if revision_id:
            query = query.where(CompositePreparation.revision_id == revision_id)
        prep = db.scalar(query.order_by(CompositePreparation.next_at, CompositePreparation.revision_id)
                         .with_for_update(skip_locked=True).limit(1))
        if not prep:
            return None
        # Interrupted read evidence is closed before a successor takes ownership.
        if prep.lease_token:
            previous = db.get(CompositeReadAttempt, read_id(prep.lease_token))
            if previous and previous.finished_at is None:
                previous.result, previous.finished_at = "interrupted", stamp
        if prep.cursor >= prep.cutoff:
            prep.status, prep.lease_token, prep.lease_until = "queried", None, 0
            prep.state = {**prep.state, "stage": "tail_queried", "query_complete": True,
                          "coverage": "observations_only; missing minutes remain unknown"}
            return None
        revision = db.get(CompositeRevision, prep.revision_id)
        mapping = db.get(RealtimeMapping, revision.mapping_id)
        dataset = db.get(MarketDataset, mapping.target_dataset_id)
        end = page_end(dataset.identity, prep.cursor, prep.cutoff)
        prep.lease_token, prep.lease_until, prep.status = uid(), stamp + 60000, "running"
        db.add(CompositeReadAttempt(id=read_id(prep.lease_token), revision_id=revision.id,
            start=prep.cursor, end=end, started_at=stamp))
        return {"revision_id": revision.id, "token": prep.lease_token, "start": prep.cursor,
                "end": end, "identity": dataset.identity, "fresh_after": revision.created_at}


def _lock(db, ownership):
    prep = db.scalar(select(CompositePreparation).where(
        CompositePreparation.revision_id == ownership["revision_id"]).with_for_update())
    if (not prep or prep.lease_token != ownership["token"] or prep.lease_until <= now_ms()
            or prep.cursor != ownership["start"]):
        raise TimeoutError("Composite preparation ownership expired or superseded")
    return prep


def _finish(attempt, result, *, batch=None, read_kind=None, accepted=False):
    if not attempt or attempt.finished_at is not None:
        return
    attempt.finished_at, attempt.result, attempt.accepted = now_ms(), result, accepted
    if read_kind:
        attempt.read_kind = read_kind
    if batch:
        attempt.checkpoint, attempt.observed_at, attempt.observations = (
            batch.checkpoint, batch.observed_at, len(batch.rows))


def commit(ownership, batch, *, read_kind="supplier_request"):
    identity = DatasetIdentity.model_validate(ownership["identity"])
    if (batch.identity != identity or (batch.window_start, batch.window_end) != (
            ownership["start"], ownership["end"])):
        raise ValueError("Composite supplier returned another source/window")
    with transaction() as db:
        from .market_datasets import validate_ingestion

        target = db.get(MarketDataset, identity.key)
        if not target:
            raise ValueError("Composite target dataset missing")
        validate_ingestion(db, db.get(Instrument, target.instrument_id), batch.ingestion_payload())
        # Global lock order: source, then preparation. Any obsolete lease rolls
        # back these source writes too; it cannot emit a composite input event.
        recorded = record(db, batch)
        prep = _lock(db, ownership)
        apply_minutes(db, recorded, revision_id=prep.revision_id, reason="preparation")
        prep.cursor = batch.checkpoint
        prep.error, prep.lease_token, prep.lease_until, prep.next_at = None, None, 0, 0
        complete = prep.cursor == prep.cutoff
        prep.status = "queried" if complete else "pending"
        prep.state = {**prep.state, "stage": "tail_queried" if complete else "confirm_recent_m1",
            "query_complete": complete, "attempts": 0,
            "coverage": "observations_only; missing minutes remain unknown"}
        _finish(db.get(CompositeReadAttempt, read_id(ownership["token"])), batch.result.status,
                batch=batch, read_kind=read_kind, accepted=True)


def failed(ownership, error, *, batch=None, read_kind=None):
    result = error.result if isinstance(error, MarketRequestError) else failed_request(error, observed_at=now_ms())
    busy = isinstance(error, AcquisitionBusy)
    permanent = isinstance(error, HistoryConfigurationError) or result.status == "unauthorized"
    with transaction() as db:
        attempt = db.get(CompositeReadAttempt, read_id(ownership["token"]))
        try:
            prep = _lock(db, ownership)
        except TimeoutError:
            _finish(attempt, "discarded", batch=batch, read_kind=read_kind)
            return
        count = prep.state.get("attempts", 0) + (0 if busy else 1)
        status = "shared_busy" if busy else "configuration_error" if permanent else result.status
        prep.error, prep.status = status, "configuration_error" if permanent else "retrying"
        prep.lease_token, prep.lease_until = None, 0
        delay = 1000 if busy else min(60000, 1000 * 2 ** min(count, 6))
        prep.next_at = max(now_ms() + delay, result.retry_at or 0)
        prep.state = {**prep.state, "attempts": count}
        _finish(attempt, status, batch=batch, read_kind=read_kind)


def preparation_tick(adapter, revision_id=None):
    ownership = claim(revision_id)
    if not ownership:
        return False
    batch, evidence = None, {}
    try:
        with lane("history"):
            batch = shared_page(adapter, DatasetIdentity.model_validate(ownership["identity"]),
                ownership["start"], ownership["end"], fresh_after=ownership["fresh_after"], evidence=evidence)
        if not batch.result.successful:
            raise MarketRequestError(batch.result)
        commit(ownership, batch, read_kind=evidence.get("read_kind", "supplier_request"))
    except Exception as error:
        failed(ownership, error, batch=batch, read_kind=evidence.get("read_kind"))
    return True
