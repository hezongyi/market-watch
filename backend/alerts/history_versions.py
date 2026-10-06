"""Fixed-cutoff imports, immutable snapshots and source-specific coverage reports."""

import argparse
import gzip
import hashlib
import json
import time
from datetime import UTC, datetime

from sqlalchemy import select

from .config import settings
from .dukascopy_history import DukascopyHistory
from .market_contracts import DatasetIdentity
from .market_datasets import register_dataset
from .market_resources import cooldown, lane
from .storage import (
    HistoryChunk,
    HistoryVersion,
    Instrument,
    MarketDataset,
    bootstrap,
    now_ms,
    transaction,
    uid,
)


def month_end(stamp):
    value = datetime.fromtimestamp(stamp / 1000, UTC)
    year, month = (value.year + 1, 1) if value.month == 12 else (value.year, value.month + 1)
    return int(datetime(year, month, 1, tzinfo=UTC).timestamp() * 1000)


def create_version(db, dataset_id, start, end):
    dataset = db.get(MarketDataset, dataset_id)
    if not dataset:
        raise ValueError("Unknown dataset")
    identity = DatasetIdentity.model_validate(dataset.identity)
    if (identity.source, identity.channel, identity.environment) != (
            "dukascopy", "python", "historical"):
        raise ValueError("Historical backtests require a Dukascopy Python dataset")
    if not 0 <= start < end <= (now_ms() - 5000) // 60000 * 60000 or start % 60000 or end % 60000:
        raise ValueError("Historical version requires fixed past UTC minute boundaries")
    version = HistoryVersion(dataset_id=dataset_id, start=start, end=end, cursor=start)
    db.add(version)
    db.flush()
    return version.id


def _unknown(rows, start, end):
    result = []
    cursor = start
    for row in rows:
        if row.timestamp > cursor:
            result.append([cursor, row.timestamp])
        cursor = row.timestamp + 60000
    if cursor < end:
        result.append([cursor, end])
    return result


def claim(version_id=None):
    with transaction() as db:
        stamp = now_ms()
        query = select(HistoryVersion).where(
            HistoryVersion.status.in_(("pending", "running", "retrying")),
            HistoryVersion.lease_until <= stamp, HistoryVersion.next_at <= stamp)
        if version_id:
            query = query.where(HistoryVersion.id == version_id)
        version = db.scalar(query.order_by(HistoryVersion.created_at)
                            .with_for_update(skip_locked=True).limit(1))
        if not version:
            return None
        version.status = "running"
        version.lease_token = uid()
        version.lease_until = stamp + 60000
        dataset = db.get(MarketDataset, version.dataset_id)
        return (version.id, version.lease_token, version.cursor,
                min(version.end, month_end(version.cursor)), dataset.identity)


def publish(db, version):
    chunks = db.scalars(select(HistoryChunk).where(HistoryChunk.version_id == version.id)
                        .order_by(HistoryChunk.start)).all()
    cursor = version.start
    count = 0
    unknown_minutes = 0
    checksum = hashlib.sha256()
    manifest_chunks = []
    for chunk in chunks:
        if chunk.start != cursor or chunk.end <= cursor:
            raise ValueError("Historical snapshot chunks are not a contiguous query partition")
        raw = gzip.decompress(chunk.content)
        if hashlib.sha256(raw).hexdigest() != chunk.checksum:
            raise ValueError("Historical chunk content checksum mismatch")
        cursor = chunk.end
        count += chunk.count
        unknown_minutes += sum((end - start) // 60000 for start, end in chunk.unknown)
        checksum.update(chunk.checksum.encode())
        manifest_chunks.append({"id": chunk.id, "start": chunk.start, "end": chunk.end,
                                "count": chunk.count, "checksum": chunk.checksum})
    if cursor != version.end:
        raise ValueError("Historical query partition is incomplete")
    dataset = db.get(MarketDataset, version.dataset_id)
    version.manifest = {
        "dataset_version": version.id, "identity": dataset.identity,
        "start": version.start, "end": version.end,
        "volume_kind": dataset.volume_kind, "volume_unit": dataset.volume_unit,
        "rows": count, "unknown_minutes": unknown_minutes,
        "coverage": "observed_only; unobserved intervals remain unknown",
        "checksum": checksum.hexdigest(), "chunks": manifest_chunks,
    }
    version.status = "published"
    version.published_at = now_ms()
    version.lease_token = None
    version.lease_until = 0
    version.error = None


def import_page(adapter, *, version_id=None):
    ownership = claim(version_id)
    if ownership is None:
        return False
    ident, token, start, end, raw_identity = ownership
    batch = None
    try:
        with lane("history"):
            batch = adapter.page(DatasetIdentity.model_validate(raw_identity), start, end)
        if not batch.result.successful:
            if batch.result.status == "rate_limited":
                seconds = max(1, (batch.result.retry_at - now_ms()) / 1000) if batch.result.retry_at else None
                cooldown("dukascopy", retry_seconds=seconds)
            from .market_contracts import MarketRequestError

            raise MarketRequestError(batch.result)
        if (batch.identity.model_dump() != raw_identity or batch.checkpoint is None
                or (batch.window_start, batch.window_end) != (start, end)):
            raise ValueError("Adapter returned another dataset or omitted the checkpoint")
        checkpoint = batch.checkpoint
        if not start < checkpoint <= end:
            raise ValueError("Import checkpoint did not advance")
        if any(not row.complete or row.timestamp + 60000 > checkpoint for row in batch.rows):
            raise ValueError("Historical page is not confirmed within its checkpoint")
        content = json.dumps([row.model_dump() for row in batch.rows],
                             sort_keys=True, separators=(",", ":")).encode()
        with transaction() as db:
            version = db.scalar(select(HistoryVersion).where(HistoryVersion.id == ident)
                                .with_for_update())
            if (version.lease_token != token or version.cursor != start
                    or version.lease_until <= now_ms()):
                return True
            dataset = db.get(MarketDataset, version.dataset_id)
            from .market import ingest

            ingest(db, db.get(Instrument, dataset.instrument_id), batch.ingestion_payload(),
                   defer_aggregation=True)
            db.add(HistoryChunk(version_id=ident, start=start, end=checkpoint,
                observed_at=batch.observed_at, count=len(batch.rows),
                checksum=hashlib.sha256(content).hexdigest(), content=gzip.compress(content, mtime=0),
                result=batch.result.status, unknown=_unknown(batch.rows, start, checkpoint)))
            version.cursor = checkpoint
            version.lease_token = None
            version.lease_until = 0
            version.attempts = 0
            version.error = None
            db.flush()
            if version.cursor == version.end:
                publish(db, version)
            else:
                version.status = "pending"
        return True
    except Exception as error:
        with transaction() as db:
            version = db.scalar(select(HistoryVersion).where(HistoryVersion.id == ident)
                                .with_for_update())
            if version.lease_token != token:
                return True
            version.attempts += 1
            result = batch.result if batch and not batch.result.successful else None
            version.error = result.status if result else "invalid_payload"
            version.next_at = (result.retry_at if result and result.retry_at else
                               now_ms() + min(900000, 1000 * 2 ** min(version.attempts, 10)))
            version.status = "configuration_error" if result and result.status == "unauthorized" else "retrying"
            version.lease_token = None
            version.lease_until = 0
        # Exceptions are captured as structured safe types, not supplier bodies.
        if not isinstance(error, (ValueError, RuntimeError, TimeoutError)):
            raise
        return True


def version_report(db, ident):
    version = db.get(HistoryVersion, ident)
    if not version:
        raise ValueError("Unknown dataset version")
    return {"id": version.id, "dataset_id": version.dataset_id, "start": version.start,
            "end": version.end, "cursor": version.cursor, "status": version.status,
            "error": version.error, "attempts": version.attempts, "next_at": version.next_at,
            "manifest": version.manifest}


def snapshot_rows(db, ident, *, start=None, end=None):
    """Stream immutable original M1 with per-chunk content verification."""
    version = db.get(HistoryVersion, ident)
    if not version or version.status != "published":
        raise ValueError("A published historical dataset version is required")
    left = version.start if start is None else start
    right = version.end if end is None else end
    if not version.start <= left < right <= version.end:
        raise ValueError("Historical version does not cover requested query partition")
    query = select(HistoryChunk).where(HistoryChunk.version_id == ident,
        HistoryChunk.start < right, HistoryChunk.end > left).order_by(HistoryChunk.start)
    for chunk in db.scalars(query.execution_options(yield_per=1)):
        raw = gzip.decompress(chunk.content)
        if hashlib.sha256(raw).hexdigest() != chunk.checksum:
            raise ValueError("Historical chunk content checksum mismatch")
        for row in json.loads(raw):
            if left <= row["timestamp"] < right:
                yield row


def main():
    parser = argparse.ArgumentParser(description="Source-isolated Dukascopy historical versions")
    parser.add_argument("--create", choices=("EURUSD", "XAUUSD"))
    parser.add_argument("--start")
    parser.add_argument("--end")
    parser.add_argument("--calendar-version")
    parser.add_argument("--precision", type=int)
    parser.add_argument("--version")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--report", action="store_true")
    args = parser.parse_args()
    bootstrap()
    version_id = args.version
    if args.create:
        if not all((args.start, args.end, args.calendar_version)) or args.precision is None:
            parser.error("Create requires explicit start/end, reviewed calendar version and precision")
        start, end = [int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)
                      for value in (args.start, args.end)]
        identity = DatasetIdentity(source="dukascopy", channel="python", environment="historical",
            account_scope="public", provider_symbol=args.create[:3] + "/" + args.create[3:],
            basis="bid", calendar_version=args.calendar_version)
        with transaction() as db:
            inst = register_dataset(db, identity, logical_symbol=args.create, label=args.create,
                calendar="ny17", precision=args.precision, volume_kind="quantity",
                volume_unit="source_quantity")
            version_id = create_version(db, identity.key, start, end)
            print(json.dumps({"version": version_id, "instrument": inst.id}))
    if args.report:
        with transaction() as db:
            print(json.dumps(version_report(db, version_id)))
        return
    adapter = DukascopyHistory(proxy=settings.market_proxy)
    try:
        while True:
            worked = import_page(adapter, version_id=version_id)
            if args.once:
                return
            time.sleep(1 if worked else 5)
    finally:
        adapter.close()


if __name__ == "__main__":
    main()
