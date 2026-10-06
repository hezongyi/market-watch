"""Shared, fenced source M1 acquisition and immutable content-addressed storage.

Query metadata can advance, while published versions retain their own observation
time and immutable blob reference. No transaction spans supplier I/O.
"""

import gzip
import hashlib
import json

from sqlalchemy import select

from .market_contracts import CandleBatch, RequestResult
from .source_registry import collection_identity
from .storage import (
    HistoryVersion,
    MarketDataset,
    SourceBlob,
    SourceFetch,
    SourceSeries,
    now_ms,
    transaction,
    uid,
)


class AcquisitionBusy(RuntimeError):
    pass


def _insert(db):
    from sqlalchemy.dialects.postgresql import insert as postgres_insert
    from sqlalchemy.dialects.sqlite import insert as sqlite_insert

    return postgres_insert if db.get_bind().dialect.name == "postgresql" else sqlite_insert


def raw_chunk(db, chunk):
    if chunk.content_id:
        blob = db.get(SourceBlob, chunk.content_id)
        version = db.get(HistoryVersion, chunk.version_id)
        dataset = db.get(MarketDataset, version.dataset_id)
        if (not blob or blob.checksum != chunk.checksum
                or blob.source_id != collection_identity(dataset.identity).key):
            raise ValueError("Historical source content reference mismatch")
        compressed = blob.content
    else:
        compressed = chunk.content
    raw = gzip.decompress(compressed)
    if hashlib.sha256(raw).hexdigest() != chunk.checksum:
        raise ValueError("Historical chunk content checksum mismatch")
    return raw


def store_blob(db, source_id, raw):
    checksum = hashlib.sha256(raw).hexdigest()
    key = hashlib.sha256((source_id + "|" + checksum).encode()).hexdigest()
    db.execute(_insert(db)(SourceBlob).values(id=key, source_id=source_id, checksum=checksum,
        content=gzip.compress(raw, mtime=0)).on_conflict_do_nothing(index_elements=["id"]))
    blob = db.get(SourceBlob, key)
    if blob.source_id != source_id or blob.checksum != checksum or gzip.decompress(blob.content) != raw:
        raise ValueError("Source content collision")
    return key, checksum


def shared_page(adapter, identity, start, end, *, fresh_after):
    source = collection_identity(identity)
    key = hashlib.sha256(f"{source.key}|{start}|{end}".encode()).hexdigest()
    with transaction() as db:
        insert = _insert(db)
        db.execute(insert(SourceSeries).values(id=source.key, identity=source.model_dump())
                   .on_conflict_do_nothing(index_elements=["id"]))
        db.execute(insert(SourceFetch).values(id=key, source_id=source.key, start=start, end=end,
                                             fetched_at=0, lease_until=0)
                   .on_conflict_do_nothing(index_elements=["id"]))
        fetch = db.scalar(select(SourceFetch).where(SourceFetch.id == key).with_for_update())
        if fetch.content_id and fetch.fetched_at > fresh_after:
            blob = db.get(SourceBlob, fetch.content_id)
            raw = gzip.decompress(blob.content)
            if hashlib.sha256(raw).hexdigest() != blob.checksum or blob.source_id != source.key:
                raise ValueError("Shared M1 content checksum mismatch")
            rows = json.loads(raw)
            return CandleBatch(identity=identity, window_start=start, window_end=end,
                observed_at=fetch.observed_at, checkpoint=fetch.checkpoint,
                result=RequestResult(status=fetch.result), rows=rows,
                volume_kind="price_count" if identity.source == "oanda" else "quantity",
                volume_unit="quotes" if identity.source == "oanda" else "source_quantity")
        if fetch.lease_until > now_ms():
            raise AcquisitionBusy("source_page_in_progress")
        token = uid()
        fetch.lease_token, fetch.lease_until = token, now_ms() + 60000
    try:
        batch = adapter.page(identity, start, end)
        expected_volume = ("price_count", "quotes") if identity.source == "oanda" else ("quantity", "source_quantity")
        if (batch.volume_kind, batch.volume_unit) != expected_volume:
            raise ValueError("Shared source volume semantics mismatch")
        if (batch.identity != identity or (batch.window_start, batch.window_end) != (start, end)
                or batch.checkpoint is None or not start < batch.checkpoint <= end
                or any(not row.complete or row.timestamp + 60000 > batch.checkpoint for row in batch.rows)):
            if batch.result.successful:
                raise ValueError("Invalid shared source page or checkpoint")
        with transaction() as db:
            fetch = db.scalar(select(SourceFetch).where(SourceFetch.id == key).with_for_update())
            if fetch.lease_token != token or fetch.lease_until <= now_ms():
                raise AcquisitionBusy("source_page_lease_replaced")
            if batch.result.successful:
                raw = json.dumps([row.model_dump() for row in batch.rows], sort_keys=True,
                                 separators=(",", ":")).encode()
                fetch.content_id, _ = store_blob(db, source.key, raw)
                fetch.checkpoint, fetch.observed_at = batch.checkpoint, batch.observed_at
                fetch.result, fetch.fetched_at = batch.result.status, now_ms()
            fetch.lease_token, fetch.lease_until = None, 0
        return batch
    except BaseException:
        with transaction() as db:
            fetch = db.scalar(select(SourceFetch).where(SourceFetch.id == key).with_for_update())
            if fetch.lease_token == token:
                fetch.lease_token, fetch.lease_until = None, 0
        raise
