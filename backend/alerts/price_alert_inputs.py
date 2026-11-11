"""Bounded per-dataset observations, committed with the collector's snapshot.

Lock order: dataset -> LiveState (if needed) -> retention mutex -> stream. Never acquire an alert
row here. Registration takes the dataset FOR UPDATE; collectors already hold
its KEY SHARE lock, so the first rule and the next observation cannot race.
"""

from decimal import Decimal, InvalidOperation

from sqlalchemy import delete, func, or_, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from .storage import ChartAlert, ChartAlertVersion, PriceAlertInput, PriceAlertStream, transaction

MAX_AGE_MS = 24 * 60 * 60 * 1000
MAX_DATASET_INPUTS = 100_000
MAX_GLOBAL_INPUTS = 1_000_000
PRUNE_BATCH = 4096


def is_price_rule(config):
    """Only fixed prices/ranges and infinite horizontal lines use price-v2."""
    if hasattr(config, "model_dump"):
        config = config.model_dump()
    condition = config.get("condition") or {}
    if (config.get("series_kind") != "composite"
            or condition.get("left", {}).get("kind", "price") != "price"
            or condition.get("offset") is not None):
        return False
    if condition.get("relation") in ("enter", "exit", "break_upper", "break_lower"):
        return True
    right = condition.get("right") or {}
    return right.get("kind") == "constant" or (
        right.get("kind") == "line" and (right.get("line") or {}).get("kind") == "horizontal_line")


def consumers(db, dataset_id, *, now):
    rows = db.execute(select(ChartAlert, ChartAlertVersion).join(ChartAlertVersion,
        (ChartAlertVersion.alert_id == ChartAlert.id) & (ChartAlertVersion.version == ChartAlert.version)
    ).where(ChartAlert.status == "active",
        or_(ChartAlert.expires_at.is_(None), ChartAlert.expires_at > now),
        ChartAlertVersion.market_identity["target_dataset_id"].as_string() == dataset_id,
        ChartAlertVersion.config["mode"].as_string() == "intrabar"))
    return [(alert, version) for alert, version in rows if is_price_rule(version.config)]


def retention_lock(db):
    # One short database mutex protects the global bound. No dataset/LiveState
    # lock may be acquired after this. Cleanup touches only existing log rows.
    if db.get_bind().dialect.name == "postgresql":
        db.execute(text("SELECT pg_advisory_xact_lock(8675312)"))


def register(db, dataset_id, *, now):
    """Caller must lock the dataset before saving rule/baseline in this tx."""
    retention_lock(db)
    insert = pg_insert if db.get_bind().dialect.name == "postgresql" else sqlite_insert
    db.execute(insert(PriceAlertStream).values(dataset_id=dataset_id, registered_at=now,
        sequence=0, trimmed_through=0, interrupted=False).on_conflict_do_nothing(index_elements=["dataset_id"]))
    return db.scalar(select(PriceAlertStream).where(PriceAlertStream.dataset_id == dataset_id)
        .with_for_update().execution_options(populate_existing=True))


def _write(db, stream, *, kind, price, occurred_at, received_at, mode, epoch, event_key, evidence):
    _make_room(db, stream, now=received_at)
    stream.sequence += 1
    row = PriceAlertInput(dataset_id=stream.dataset_id, sequence=stream.sequence, kind=kind,
        price=price, occurred_at=occurred_at, received_at=received_at, mode=mode,
        epoch=epoch, event_key=event_key, evidence=evidence)
    db.add(row)
    db.flush()
    return row


def interrupt(db, dataset_id, *, now, epoch, reason, mode=None, evidence=None):
    if not consumers(db, dataset_id, now=now):
        return None
    stream = register(db, dataset_id, now=now)
    if stream.interrupted:
        return None
    row = _write(db, stream, kind="interruption", price=None, occurred_at=now,
        received_at=now, mode=mode or stream.last_mode or "unknown", epoch=epoch,
        event_key=f"gap:{epoch}:{stream.sequence + 1}", evidence={"reason_code": reason,
            "possible_start": stream.last_received_at, "end": now, **(evidence or {})})
    stream.interrupted = True
    return row


def append(db, dataset_id, *, price, occurred_at, received_at, mode, epoch, event_key, evidence):
    if not consumers(db, dataset_id, now=received_at):
        return None
    stream = register(db, dataset_id, now=received_at)
    if stream.last_event_key == event_key:
        return None
    if stream.last_mode and stream.last_mode != mode and not stream.interrupted:
        interrupt(db, dataset_id, now=received_at, epoch=epoch, mode=mode, reason="observation_mode_changed")
    if stream.last_received_at is not None and not stream.interrupted:
        elapsed = received_at - stream.last_received_at
        generation_changed = stream.last_epoch is not None and stream.last_epoch != epoch
        if elapsed > 15000 or generation_changed:
            from .live_session import unclosed_milliseconds
            from .storage import Instrument, MarketDataset

            target = db.get(MarketDataset, dataset_id)
            open_ms = unclosed_milliseconds(target.identity,
                db.get(Instrument, target.instrument_id).calendar_profile,
                stream.last_received_at, received_at)
            scheduled_break = open_ms is not None and open_ms <= 15000 and elapsed > 15000
            if not scheduled_break:
                interrupt(db, dataset_id, now=received_at, epoch=epoch, mode=mode,
                    reason="unverified_connection_boundary" if generation_changed else "price_sample_gap",
                    evidence={"observation_gap_ms": elapsed, "previous_epoch": stream.last_epoch})
    row = _write(db, stream, kind="price", price=price, occurred_at=occurred_at,
        received_at=received_at, mode=mode, epoch=epoch, event_key=event_key, evidence=evidence)
    stream.last_event_key, stream.last_mode, stream.last_epoch = event_key, mode, epoch
    stream.last_received_at, stream.interrupted = received_at, False
    return row


def record_quote(db, event, *, now, profile):
    from .live_session import session_status

    try:
        bid, ask = Decimal(event.bid), Decimal(event.ask)
        valid = bid.is_finite() and ask.is_finite() and 0 < bid <= ask
    except (InvalidOperation, TypeError, ValueError):
        valid = False
    closed = session_status(event.identity.model_dump(), profile, now)["market_session"] == "closed"
    if closed:
        return None
    if (not valid or not event.tradeable or not 0 <= event.received_at - event.source_time <= 15000
            or not 0 <= now - event.received_at <= 15000 or not 0 <= now - event.source_time <= 15000):
        return interrupt(db, event.identity.key, now=now, epoch=event.connection_epoch,
            reason="invalid_price_sample", mode="stream_quote")
    return append(db, event.identity.key, price=event.bid, occurred_at=event.source_time,
        received_at=event.received_at, mode="stream_quote", epoch=event.connection_epoch,
        event_key=f"stream:{event.connection_epoch}:{event.sequence}",
        evidence={"source_sequence": event.sequence, "source_time": event.source_time,
            "validated_at": now, "basis": "bid", "tradeable": True,
            "observation_basis": "sampled_bid_quote"})


def record_rest(db, dataset_id, sample):
    return append(db, dataset_id, price=sample.close, occurred_at=sample.received_at,
        received_at=sample.received_at, mode="candle_close_sample", epoch=sample.generation,
        event_key=f"rest:{sample.generation}:{sample.sequence}",
        evidence={"source_sequence": sample.sequence, "source_start": sample.candle.start,
            "source_end": sample.candle.end, "validated_at": sample.committed_at,
            "snapshot_id": sample.snapshot_id, "basis": sample.spec.identity.basis})


def read_after(db, dataset_id, sequence, *, limit=256):
    return list(db.scalars(select(PriceAlertInput).where(PriceAlertInput.dataset_id == dataset_id,
        PriceAlertInput.sequence > sequence).order_by(PriceAlertInput.sequence).limit(limit)))


def _safe_cursor(db, stream):
    # Expired settlement retains its inputs. Acquisition demand is deliberately
    # separate: expiry stops new input while committed backlog remains readable.
    rows = db.execute(select(ChartAlert, ChartAlertVersion).join(ChartAlertVersion,
        (ChartAlertVersion.alert_id == ChartAlert.id) & (ChartAlertVersion.version == ChartAlert.version)
    ).where(or_(ChartAlert.status == "active",
        (ChartAlert.status == "expired") & ChartAlert.runtime["settlement_pending"].as_boolean()),
        ChartAlertVersion.market_identity["target_dataset_id"].as_string() == stream.dataset_id,
        ChartAlertVersion.config["mode"].as_string() == "intrabar"))
    cursors = [a.runtime.get("cursor", 0) if a.runtime.get("execution_contract") == "price-v2" else 0
               for a, v in rows if is_price_rule(v.config)]
    return min(cursors, default=stream.sequence)


def _trim(db, stream, through, *, limit=PRUNE_BATCH):
    rows = list(db.scalars(select(PriceAlertInput).where(
        PriceAlertInput.dataset_id == stream.dataset_id, PriceAlertInput.sequence <= through)
        .order_by(PriceAlertInput.sequence).limit(limit)))
    if not rows:
        return 0
    stream.trimmed_through = rows[-1].sequence
    start, end = min(r.occurred_at for r in rows), max(r.occurred_at for r in rows)
    stream.trimmed_start = min(stream.trimmed_start, start) if stream.trimmed_start is not None else start
    stream.trimmed_end = max(stream.trimmed_end, end) if stream.trimmed_end is not None else end
    db.execute(delete(PriceAlertInput).where(PriceAlertInput.dataset_id == stream.dataset_id,
        PriceAlertInput.sequence <= stream.trimmed_through))
    db.flush()
    return len(rows)


def _make_room(db, stream, *, now):
    # Register already holds the global mutex. Keep both count limits true at
    # every commit, even while the evaluator/periodic janitor is stopped.
    expire(db, stream, now=now)
    if stream.sequence - stream.trimmed_through >= MAX_DATASET_INPUTS:
        _trim(db, stream, max(_safe_cursor(db, stream), stream.sequence - MAX_DATASET_INPUTS + 1))
    total = db.scalar(select(func.coalesce(func.sum(
        PriceAlertStream.sequence - PriceAlertStream.trimmed_through), 0)))
    if total < MAX_GLOBAL_INPUTS:
        return
    for candidate in db.scalars(select(PriceAlertStream).order_by(PriceAlertStream.dataset_id)
            .execution_options(populate_existing=True)):
        if _trim(db, candidate, _safe_cursor(db, candidate)):
            return  # Acknowledged data is always reclaimed before unread data.
    oldest = db.scalar(select(PriceAlertInput).order_by(
        PriceAlertInput.received_at, PriceAlertInput.dataset_id, PriceAlertInput.sequence).limit(1))
    if oldest:
        _trim(db, db.get(PriceAlertStream, oldest.dataset_id), oldest.sequence)


def expire(db, stream, *, now):
    """Remove the aged prefix before admitting or judging an observation.

    Only the oldest row is read during normal collection. Following a long
    outage, each deletion remains bounded and the dataset hard cap bounds the
    number of batches; stale rows can never be judged while cleanup catches up.
    """
    first = db.scalar(select(PriceAlertInput).where(PriceAlertInput.dataset_id == stream.dataset_id)
        .order_by(PriceAlertInput.sequence).limit(1))
    if not first or first.received_at >= now - MAX_AGE_MS:
        return
    through = db.scalar(select(func.max(PriceAlertInput.sequence)).where(
        PriceAlertInput.dataset_id == stream.dataset_id, PriceAlertInput.received_at < now - MAX_AGE_MS))
    while stream.trimmed_through < through:
        if not _trim(db, stream, through):
            break


def prune(db, dataset_id, *, now, max_rows=None, max_age=None):
    """Delete one bounded prefix, without acquiring dataset or alert row locks.

    Consumers take the same retention mutex before their stream read; a cursor
    cannot commit against rows concurrently deleted by this transaction.
    """
    max_rows = MAX_DATASET_INPUTS if max_rows is None else max_rows
    max_age = MAX_AGE_MS if max_age is None else max_age
    retention_lock(db)
    stream = db.scalar(select(PriceAlertStream).where(PriceAlertStream.dataset_id == dataset_id)
        .with_for_update().execution_options(populate_existing=True))
    if not stream:
        return 0
    expired = db.scalar(select(func.max(PriceAlertInput.sequence)).where(
        PriceAlertInput.dataset_id == dataset_id, PriceAlertInput.received_at < now - max_age)) or 0
    through = max(_safe_cursor(db, stream), expired, stream.sequence - max_rows)
    return _trim(db, stream, through)


def maintain(*, now):
    from .runtime_health import assert_current

    with transaction() as db:
        datasets = list(db.scalars(select(PriceAlertStream.dataset_id)))
    for dataset_id in datasets:
        for _ in range(MAX_DATASET_INPUTS // PRUNE_BATCH + 1):
            with transaction() as db:
                assert_current(db)
                removed = prune(db, dataset_id, now=now)
            if removed < PRUNE_BATCH:
                break
