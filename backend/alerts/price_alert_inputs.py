"""Bounded per-dataset observations, committed with the collector's snapshot.

Lock order: dataset -> LiveState (if needed) -> stream. Never acquire an alert
row here. Registration takes the dataset FOR UPDATE; collectors already hold
its KEY SHARE lock, so the first rule and the next observation cannot race.
"""

from decimal import Decimal, InvalidOperation

from sqlalchemy import delete, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from .storage import ChartAlert, ChartAlertVersion, MarketDataset, PriceAlertInput, PriceAlertStream

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


def register(db, dataset_id, *, now):
    """Caller must lock the dataset before saving rule/baseline in this tx."""
    insert = pg_insert if db.get_bind().dialect.name == "postgresql" else sqlite_insert
    db.execute(insert(PriceAlertStream).values(dataset_id=dataset_id, registered_at=now,
        sequence=0, trimmed_through=0, interrupted=False).on_conflict_do_nothing(index_elements=["dataset_id"]))
    return db.scalar(select(PriceAlertStream).where(PriceAlertStream.dataset_id == dataset_id)
        .with_for_update().execution_options(populate_existing=True))


def _write(db, stream, *, kind, price, occurred_at, received_at, mode, epoch, event_key, evidence):
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
            "validated_at": now, "basis": "bid", "tradeable": True})


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


def prune(db, dataset_id, *, now, max_rows=MAX_DATASET_INPUTS, max_age=MAX_AGE_MS):
    """One bounded prefix deletion, with its durable loss boundary in the same tx."""
    db.scalar(select(MarketDataset.id).where(MarketDataset.id == dataset_id).with_for_update())
    stream = db.scalar(select(PriceAlertStream).where(PriceAlertStream.dataset_id == dataset_id)
        .with_for_update().execution_options(populate_existing=True))
    if not stream:
        return 0
    rows = list(db.scalars(select(PriceAlertInput).where(PriceAlertInput.dataset_id == dataset_id,
        or_(PriceAlertInput.sequence <= stream.sequence - max_rows,
            PriceAlertInput.received_at < now - max_age))
        .order_by(PriceAlertInput.sequence).limit(PRUNE_BATCH)))
    if not rows:
        return 0
    stream.trimmed_through = rows[-1].sequence
    start, end = min(r.occurred_at for r in rows), max(r.occurred_at for r in rows)
    stream.trimmed_start = min(stream.trimmed_start, start) if stream.trimmed_start is not None else start
    stream.trimmed_end = max(stream.trimmed_end, end) if stream.trimmed_end is not None else end
    db.execute(delete(PriceAlertInput).where(PriceAlertInput.dataset_id == dataset_id,
        PriceAlertInput.sequence <= stream.trimmed_through))
    return len(rows)
