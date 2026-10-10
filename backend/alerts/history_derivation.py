"""Reuse immutable observations under a new reviewed metadata/calendar identity.

Each copied chunk and checkpoint commits together. Only metadata changes are
allowed: provider, channel, environment, account and BID series remain identical.
No staging bar is trusted as the original snapshot or copied across providers.
"""

import hashlib
import json
from decimal import Decimal

from sqlalchemy import select

from .calendar_profile import closures_from
from .domain import calendar_for, scheduled_open
from .history_versions import create_version, publish
from .market_contracts import CandleBatch, DatasetIdentity, RequestResult
from .market_datasets import validate_ingestion
from .source_history_store import raw_chunk
from .storage import (
    Audit,
    Bar,
    HistoryChunk,
    HistoryReclamation,
    HistoryVersion,
    Instrument,
    MarketCoverage,
    MarketDataset,
    instant,
    now_ms,
    transaction,
)


def derive_version(db, original_id, destination_dataset, *, quarantine_reason=None):
    parent = db.get(HistoryVersion, original_id)
    destination = db.get(MarketDataset, destination_dataset)
    if not parent or not destination:
        raise ValueError("Known parent version and destination dataset are required")
    list(db.scalars(select(MarketDataset.id).where(MarketDataset.id.in_(
        (parent.dataset_id, destination_dataset))).order_by(MarketDataset.id).with_for_update()))
    parent = db.scalar(select(HistoryVersion).where(HistoryVersion.id == original_id)
                       .with_for_update().execution_options(populate_existing=True))
    if db.get(HistoryReclamation, original_id):
        raise ValueError("原始版本价格数据已回收，不能继续派生")
    original = db.get(MarketDataset, parent.dataset_id)
    source = DatasetIdentity.model_validate(original.identity)
    target = DatasetIdentity.model_validate(destination.identity)
    for key in ("source", "channel", "environment", "account_scope", "provider_symbol", "basis"):
        if getattr(source, key) != getattr(target, key):
            raise ValueError("Derivation cannot replace provider, channel, account or price series")
    if source.key == target.key:
        raise ValueError("Derivation requires a new dataset metadata/calendar identity")
    if (original.volume_kind, original.volume_unit) != (destination.volume_kind, destination.volume_unit):
        raise ValueError("Derivation cannot reinterpret original volume")
    if parent.lease_until > now_ms() or parent.lease_token:
        raise ValueError("Stop the parent's writer and wait for its lease before deriving")
    if parent.status != "published":
        if not quarantine_reason or len(quarantine_reason) > 40:
            raise ValueError("An incomplete parent requires an explicit quarantine reason")
        parent.status = "configuration_error"
        parent.error = quarantine_reason
        parent.next_at = 0
    ident = create_version(db, destination_dataset, parent.start, parent.end)
    version = db.get(HistoryVersion, ident)
    version.status = "deriving"
    version.manifest = {**(version.manifest or {}), "provenance": {"derived_from_version": parent.id,
        "original_identity": original.identity, "original_cursor": parent.cursor,
        "copied_minutes": 0, "copied_chunks": 0, "original_prefix_checksum": hashlib.sha256(b"").hexdigest(),
        "method": "verified immutable original chunks; no price rounding or source substitution"}}
    return ident


def derive_page(ident):
    with transaction() as db:
        version = db.get(HistoryVersion, ident)
        if not version or version.status != "deriving":
            return False
        parent = db.get(HistoryVersion, version.manifest["provenance"]["derived_from_version"])
        list(db.scalars(select(MarketDataset.id).where(MarketDataset.id.in_(
            (parent.dataset_id, version.dataset_id))).order_by(MarketDataset.id).with_for_update()))
        version = db.scalar(select(HistoryVersion).where(HistoryVersion.id == ident)
                            .with_for_update().execution_options(populate_existing=True))
        if version.status != "deriving":
            return False
        proof = version.manifest["provenance"]
        parent = db.get(HistoryVersion, proof["derived_from_version"])
        if parent.cursor != proof["original_cursor"] or parent.status not in ("published", "configuration_error"):
            raise ValueError("The original derivation partition changed")
        source = db.scalar(select(HistoryChunk).where(HistoryChunk.version_id == parent.id,
                                                     HistoryChunk.start == version.cursor))
        if not source:
            if version.cursor != proof["original_cursor"]:
                raise ValueError("Parent's immutable query partition is discontinuous")
            if version.cursor == version.end:
                publish(db, version)
            else:
                version.status = "pending"
                version.next_at = now_ms()
            return True
        raw = raw_chunk(db, source)
        dataset = db.get(MarketDataset, version.dataset_id)
        inst = db.scalar(select(Instrument).where(Instrument.id == dataset.instrument_id).with_for_update())
        payload = CandleBatch(identity=DatasetIdentity.model_validate(dataset.identity),
            window_start=source.start, window_end=source.end, observed_at=source.observed_at,
            result=RequestResult(status=source.result), rows=tuple(json.loads(raw)),
            checkpoint=source.end, volume_kind=dataset.volume_kind, volume_unit=dataset.volume_unit).ingestion_payload()
        payload = {**payload, "rows": [row.model_dump() for row in validate_ingestion(db, inst, payload).rows]}
        if len(payload["rows"]) != source.count:
            raise ValueError("Original row count mismatch")
        # Destination series is new. Copy exact original JSON, never a newer
        # staging revision, and use bounded ordinary inserts in this transaction.
        values = [{"instrument_id": inst.id, "timeframe": "M1", "start": row["timestamp"],
            "end": row["timestamp"] + 60000,
            **{key: Decimal(row[key]) for key in ("open", "high", "low", "close")},
            "complete": True, "revision": 1, "received_at": now_ms(), "observed_at": source.observed_at,
            "volume": Decimal(row["volume"]) if row["volume"] is not None else None,
            "volume_complete": row["volume"] is not None, "volume_received_at": source.observed_at,
            "volume_revision": int(row["volume"] is not None)} for row in payload["rows"]]
        for offset in range(0, len(values), 500):
            db.execute(Bar.__table__.insert(), values[offset:offset + 500])
        _observed_coverage(db, inst, payload["rows"], source.observed_at)
        if values:
            from .chart_aggregation import enqueue_aggregation

            enqueue_aggregation(db, inst.id, source.start, source.end, now_ms())
            conflicts = [row["start"] for row in values if not scheduled_open(instant(row["start"]),
                calendar_for(inst), closures=closures_from(inst.calendar_profile))]
            if conflicts:
                db.add(Audit(kind="source_session_observation_conflict", details={"dataset": dataset.id,
                    "observed_minute_starts": conflicts, "observed_at": now_ms(), "derivation": ident}))
        db.add(HistoryChunk(version_id=version.id, start=source.start, end=source.end,
            observed_at=source.observed_at, count=source.count, checksum=source.checksum,
            content=source.content, content_id=source.content_id,
            result=source.result, unknown=source.unknown))
        version.cursor = source.end
        db.flush()
        digest = hashlib.sha256()
        for checksum in db.scalars(select(HistoryChunk.checksum).where(HistoryChunk.version_id == version.id)
                                   .order_by(HistoryChunk.start)):
            digest.update(checksum.encode())
        version.manifest = {**(version.manifest or {}), "provenance": {**proof,
            "copied_chunks": proof["copied_chunks"] + 1,
            "copied_minutes": proof["copied_minutes"] + source.count,
            "original_prefix_checksum": digest.hexdigest()}}
        return True


def _observed_coverage(db, inst, rows, observed_at):
    from sqlalchemy.dialects.postgresql import insert as pg_insert
    from sqlalchemy.dialects.sqlite import insert as sqlite_insert

    from .managed_dataset import _merged

    spans = [{"instrument_id": inst.id, "source": inst.source, "basis": inst.basis,
        "start": start, "end": end, "observed": (end - start) // 60000, "queried_at": observed_at}
        for start, end in _merged([{"start": row["timestamp"], "end": row["timestamp"] + 60000}
                                   for row in rows])]
    insert = pg_insert if db.get_bind().dialect.name == "postgresql" else sqlite_insert
    for offset in range(0, len(spans), 500):
        db.execute(insert(MarketCoverage).values(spans[offset:offset + 500]).on_conflict_do_nothing())


def restore_derivation_coverage_page(ident, after):
    """Repair checkpoints copied by an earlier writer without observed coverage."""
    with transaction() as db:
        version = db.get(HistoryVersion, ident)
        if not version or not version.manifest.get("provenance"):
            raise ValueError("Coverage restoration requires original derivation provenance")
        chunk = db.scalar(select(HistoryChunk).where(HistoryChunk.version_id == ident,
            HistoryChunk.start >= after).order_by(HistoryChunk.start).limit(1))
        if not chunk:
            return None
        raw = raw_chunk(db, chunk)
        dataset = db.get(MarketDataset, version.dataset_id)
        inst = db.scalar(select(Instrument).where(Instrument.id == dataset.instrument_id).with_for_update())
        _observed_coverage(db, inst, json.loads(raw), chunk.observed_at)
        return chunk.end
