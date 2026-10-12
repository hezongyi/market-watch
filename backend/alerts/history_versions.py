"""Fixed-cutoff imports, immutable snapshots and source-specific coverage reports."""

import argparse
import hashlib
import json
import time
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import select

from .history_maintenance import bounded_refresh, on_publish, reusable_page
from .history_request_evidence import attempt_id
from .history_request_evidence import finish as finish_read
from .history_request_evidence import snapshot as read_snapshot
from .history_request_evidence import start as start_read
from .history_sources import HistoryConfigurationError, HistorySources, history_identity, page_end
from .market_contracts import DatasetIdentity, failed_request
from .market_datasets import PRICE_RULE_VERSION, PricePrecisionError, version_price_rows, register_dataset
from .market_resources import cooldown, lane
from .source_history_store import AcquisitionBusy, raw_chunk, shared_page, store_blob
from .source_registry import collection_identity
from .transaction_retry import is_conflict, retry_conflicts
from .storage import (
    HistoryChunk,
    HistoryReadAttempt,
    HistoryReclamation,
    HistoryRun,
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
    history_identity(dataset.identity)
    if not 0 <= start < end <= (now_ms() - 5000) // 60000 * 60000 or start % 60000 or end % 60000:
        raise ValueError("Historical version requires fixed past UTC minute boundaries")
    dataset_row = db.get(MarketDataset, dataset_id)
    instrument = db.get(Instrument, dataset_row.instrument_id)
    version = HistoryVersion(dataset_id=dataset_id, start=start, end=end, cursor=start,
                             manifest={"price_precision": instrument.precision,
                                       "price_rule_version": PRICE_RULE_VERSION})
    db.add(version)
    db.flush()
    return version.id


def lock_version(db, ident):
    parent = db.get(HistoryVersion, ident)
    if parent:
        db.scalar(select(MarketDataset.id).where(MarketDataset.id == parent.dataset_id).with_for_update())
    return db.scalar(select(HistoryVersion).where(HistoryVersion.id == ident)
                     .with_for_update().execution_options(populate_existing=True))


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
            HistoryVersion.lease_until <= stamp, HistoryVersion.next_at <= stamp,
            ~select(HistoryRun.version_id).where(HistoryRun.version_id == HistoryVersion.id,
                HistoryRun.desired_state != "running").exists())
        if version_id:
            query = query.where(HistoryVersion.id == version_id)
        candidate = db.scalar(query.join(MarketDataset).order_by(HistoryVersion.next_at, HistoryVersion.created_at)
                            .with_for_update(skip_locked=True, of=MarketDataset).limit(1))
        version = lock_version(db, candidate.id) if candidate else None
        if not version:
            return None
        version.status = "running"
        version.lease_token = uid()
        version.lease_until = stamp + 60000
        dataset = db.get(MarketDataset, version.dataset_id)
        end = bounded_refresh(db, version, page_end(dataset.identity, version.cursor,
                         min(version.end, month_end(version.cursor))))
        start_read(db, version.id, version.lease_token, version.cursor, end)
        return (version.id, version.lease_token, version.cursor, end, dataset.identity)


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
        raw_chunk(db, chunk)
        cursor = chunk.end
        count += chunk.count
        unknown_minutes += sum((end - start) // 60000 for start, end in chunk.unknown)
        checksum.update(chunk.checksum.encode())
        manifest_chunks.append({"id": chunk.id, "start": chunk.start, "end": chunk.end,
                                "count": chunk.count, "checksum": chunk.checksum})
    if cursor != version.end:
        raise ValueError("Historical query partition is incomplete")
    dataset = db.get(MarketDataset, version.dataset_id)
    instrument = db.get(Instrument, dataset.instrument_id)
    existing = version.manifest or {}
    price_manifest = {}
    if existing.get("price_rule_version") and "price_precision" in existing:
        price_manifest = {"price_precision": existing["price_precision"],
                          "price_rule_version": existing["price_rule_version"]}
    version.manifest = {
        "dataset_version": version.id, "identity": dataset.identity,
        "start": version.start, "end": version.end,
        "volume_kind": dataset.volume_kind, "volume_unit": dataset.volume_unit,
        "asset_class": dataset.asset_class, "aggregation_calendar": instrument.calendar, "calendar_profile": instrument.calendar_profile,
        "rows": count, "unknown_minutes": unknown_minutes,
        "coverage": "observed_only; unobserved intervals remain unknown",
        "checksum": checksum.hexdigest(), "chunks": manifest_chunks,
        "request_evidence": read_snapshot(db, version.id),
        **price_manifest,
        **({"price_rule_activation": version.manifest["price_rule_activation"]}
           if version.manifest.get("price_rule_activation") else {}),
        **({"provenance": version.manifest["provenance"]} if version.manifest.get("provenance") else {}),
        **({"maintenance": version.manifest["maintenance"]} if version.manifest.get("maintenance") else {}),
    }
    version.status = "published"
    version.published_at = now_ms()
    version.lease_token = None
    version.lease_until = 0
    version.error = None
    on_publish(db, version)
    from .history_artifacts import request_artifacts
    from .storage import DatasetMaintenance

    plan = db.get(DatasetMaintenance, version.dataset_id)
    frames = version.manifest.get("maintenance", {}).get("timeframes",
        plan.timeframes if plan else ["M1"])
    request_artifacts(db, version, frames)


def controlled_stop(db, version):
    run = db.get(HistoryRun, version.id)
    if not run or run.desired_state == "running":
        return False
    version.status = run.desired_state
    version.lease_token, version.lease_until = None, 0
    if version.status == "cancelled":
        from .storage import DatasetMaintenance

        plan = db.get(DatasetMaintenance, version.dataset_id)
        if plan.active_version_id == version.id:
            plan.active_version_id = None
    return True


def import_page(adapter, *, version_id=None):
    with transaction() as db:
        query = select(HistoryVersion.id).where(HistoryVersion.status == "deriving")
        if version_id:
            query = query.where(HistoryVersion.id == version_id)
        deriving = db.scalar(query.order_by(HistoryVersion.created_at).limit(1))
    if deriving:
        from .history_derivation import derive_page

        return derive_page(deriving)
    ownership = retry_conflicts(lambda: claim(version_id))
    if ownership is None:
        return False
    ident, token, start, end, raw_identity = ownership
    read_id = attempt_id(token)
    batch = None
    evidence = {}
    try:
        with transaction() as db:
            version = lock_version(db, ident)
            if version.lease_token != token or version.lease_until <= now_ms():
                return True
            if controlled_stop(db, version):
                finish_read(db.get(HistoryReadAttempt, read_id), "discarded")
                return True
            fresh_after = version.created_at
            reuse = reusable_page(db, version, db.get(HistoryRun, ident))
            if reuse:
                attempt = db.get(HistoryReadAttempt, read_id)
                attempt.checkpoint, attempt.observed_at, attempt.observations = reuse.end, reuse.observed_at, reuse.count
                finish_read(attempt, "inherited", read_kind="parent_reuse", accepted=True)
                db.add(reuse)
                version.cursor = reuse.end
                version.lease_token, version.lease_until = None, 0
                version.status = "pending"
                db.flush()
                if version.cursor == version.end:
                    publish(db, version)
                return True
        with lane("history"):
            batch = shared_page(adapter, DatasetIdentity.model_validate(raw_identity), start, end,
                                fresh_after=fresh_after, evidence=evidence)
        if not batch.result.successful:
            if batch.result.status == "rate_limited" and raw_identity["source"] != "oanda":
                seconds = max(1, (batch.result.retry_at - now_ms()) / 1000) if batch.result.retry_at else None
                cooldown(raw_identity["source"], retry_seconds=seconds)
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
        def commit_page():
            with transaction() as db:
                version = lock_version(db, ident)
                if (version.lease_token != token or version.cursor != start
                        or version.lease_until <= now_ms()):
                    finish_read(db.get(HistoryReadAttempt, read_id), "discarded", batch=batch,
                                read_kind=evidence.get("read_kind"))
                    return True
                if controlled_stop(db, version):
                    finish_read(db.get(HistoryReadAttempt, read_id), "discarded", batch=batch,
                                read_kind=evidence.get("read_kind"))
                    return True
                dataset = db.get(MarketDataset, version.dataset_id)
                from .market import ingest

                ingest(db, db.get(Instrument, dataset.instrument_id), batch.ingestion_payload(),
                       defer_aggregation=True, price_manifest=version.manifest or {})
                content_id, checksum = store_blob(db, collection_identity(raw_identity).key, content)
                db.add(HistoryChunk(version_id=ident, start=start, end=checkpoint,
                    observed_at=batch.observed_at, count=len(batch.rows),
                    checksum=checksum, content=b"", content_id=content_id,
                    result=batch.result.status, unknown=_unknown(batch.rows, start, checkpoint)))
                version.cursor = checkpoint
                version.lease_token = None
                version.lease_until = 0
                version.attempts = 0
                version.error = None
                version.next_at = now_ms()
                finish_read(db.get(HistoryReadAttempt, read_id), batch.result.status, batch=batch,
                            read_kind=evidence.get("read_kind"), accepted=True)
                db.flush()
                if version.cursor == version.end:
                    publish(db, version)
                else:
                    version.status = "pending"
            return True

        return retry_conflicts(commit_page)
    except AcquisitionBusy:
        with transaction() as db:
            version = lock_version(db, ident)
            finish_read(db.get(HistoryReadAttempt, read_id), "shared_busy", read_kind=evidence.get("read_kind"))
            if version.lease_token == token:
                version.status, version.next_at = "pending", now_ms() + 1000
                version.lease_token, version.lease_until = None, 0
        return True
    except Exception as error:
        with transaction() as db:
            version = lock_version(db, ident)
            if version.lease_token != token:
                finish_read(db.get(HistoryReadAttempt, read_id), "discarded", batch=batch,
                            read_kind=evidence.get("read_kind"))
                return True
            if controlled_stop(db, version):
                finish_read(db.get(HistoryReadAttempt, read_id), "discarded", batch=batch,
                            read_kind=evidence.get("read_kind"))
                return True
            version.attempts += 1
            result = batch.result if batch and not batch.result.successful else failed_request(error, observed_at=now_ms())
            metadata_failure = isinstance(error, PricePrecisionError)
            configuration_failure = isinstance(error, HistoryConfigurationError)
            version.error = ("price_precision_overflow" if metadata_failure else
                             "history_source_configuration" if configuration_failure else
                             "database_conflict" if is_conflict(error) else
                             result.status if result else "invalid_payload")
            finish_read(db.get(HistoryReadAttempt, read_id), version.error, batch=batch,
                        read_kind=evidence.get("read_kind"))
            version.next_at = (result.retry_at if result and result.retry_at else
                               now_ms() + min(900000, 1000 * 2 ** min(version.attempts, 10)))
            version.status = "configuration_error" if metadata_failure or configuration_failure or (
                result and result.status == "unauthorized") else "retrying"
            version.lease_token = None
            version.lease_until = 0
        # Exceptions are captured as structured safe types, not supplier bodies.
        if not isinstance(error, (ValueError, RuntimeError, TimeoutError)) and not is_conflict(error):
            raise
        return True


def version_report(db, ident):
    version = db.get(HistoryVersion, ident)
    if not version:
        raise ValueError("Unknown dataset version")
    run = db.get(HistoryRun, version.id)
    from sqlalchemy import func

    from .history_maintenance import task_status

    # Times come from persisted events. Legacy mutation timestamps remain
    # unknown; poll time and lease deadlines are not task update timestamps.
    from .storage import HistoryArtifact, HistoryReadAttempt
    from .history_artifacts import derivation_progress

    started_at = db.scalar(select(func.min(HistoryReadAttempt.started_at)).where(
        HistoryReadAttempt.version_id == version.id))
    artifact_at = db.scalar(select(func.max(HistoryArtifact.updated_at)).where(
        HistoryArtifact.version_id == version.id))
    recorded = [value for value in (version.updated_at, version.published_at, artifact_at,
        run.updated_at if run else None, run.completed_at if run else None) if value is not None]
    return {"id": version.id, "dataset_id": version.dataset_id, "start": version.start,
            "created_at": version.created_at, "started_at": started_at,
            "updated_at": max(recorded) if recorded else None,
            "end": version.end, "cursor": version.cursor, "status": version.status,
            "published_at": version.published_at,
            "error": version.error, "attempts": version.attempts, "next_at": version.next_at,
            "payload_available": db.get(HistoryReclamation, ident) is None,
            "manifest": version.manifest, "task_kind": run.kind if run else (
                "derive" if version.manifest.get("provenance", {}).get("derived_from_version") else "import"),
            "desired_state": run.desired_state if run else None,
            "task_status": task_status(db, version),
            "completed_at": run.completed_at if run else None,
            "parent_version_id": run.parent_version_id if run else None,
            "refresh_start": run.refresh_start if run else None, "refresh_end": run.refresh_end if run else None,
            "derivation": derivation_progress(db, version)}


def snapshot_rows(db, ident, *, start=None, end=None):
    """Stream immutable original M1 with per-chunk content verification."""
    version = db.get(HistoryVersion, ident)
    if not version or version.status != "published":
        raise ValueError("A published historical dataset version is required")
    db.scalar(select(MarketDataset.id).where(MarketDataset.id == version.dataset_id)
              .with_for_update(read=True))
    if db.get(HistoryReclamation, ident):
        raise ValueError("该历史版本价格数据已回收；版本身份与发布清单保留")
    left = version.start if start is None else start
    right = version.end if end is None else end
    if not version.start <= left < right <= version.end:
        raise ValueError("Historical version does not cover requested query partition")
    query = select(HistoryChunk).where(HistoryChunk.version_id == ident,
        HistoryChunk.start < right, HistoryChunk.end > left).order_by(HistoryChunk.start)
    for chunk in db.scalars(query.execution_options(yield_per=1)):
        raw = raw_chunk(db, chunk)
        rows = version_price_rows(json.loads(raw), version.manifest)
        for row in rows:
            if left <= row["timestamp"] < right:
                yield row


def worker_tick(adapter, *, version_id=None, without_composite_aggregates=False):
    """Isolate each role's failed round so unrelated runnable work still runs."""
    from .history_artifacts import artifact_tick

    worked = False

    def phase(name, operation):
        nonlocal worked
        try:
            worked = bool(operation()) or worked
        except Exception as error:
            # Only safe structural facts. Supplier payloads and SQL parameters
            # can contain private account configuration and are never printed.
            print(json.dumps({"component": "history_worker", "phase": name,
                "error_type": type(error).__name__,
                "sqlstate": getattr(getattr(error, "orig", None), "sqlstate", None)}), flush=True)

    phase("artifacts", lambda: artifact_tick(version_id))
    if not version_id:
        from .composite_aggregates import aggregate_tick
        from .composite_preparation import preparation_tick
        from .composite_revisions import preparation_tick as revision_tick
        from .fixed_indicators import indicator_tick
        from .history_maintenance import schedule_tick

        phase("schedule", schedule_tick)
        phase("preparation", lambda: preparation_tick(adapter))
        if not without_composite_aggregates:
            phase("composite_aggregates", aggregate_tick)
        phase("indicators", indicator_tick)
        phase("revisions", revision_tick)
    phase("import", lambda: import_page(adapter, version_id=version_id))
    return worked


def main():
    parser = argparse.ArgumentParser(description="Source-isolated managed historical versions")
    parser.add_argument("--create", help="Canonical logical symbol, e.g. EURUSD or BTCUSD")
    parser.add_argument("--provider-symbol", help="Exact Dukascopy symbol, e.g. EUR/USD")
    parser.add_argument("--asset-class", choices=("forex", "metal", "crypto", "index", "other"))
    parser.add_argument("--aggregation-calendar", choices=("ny17", "utc0"))
    parser.add_argument("--start")
    parser.add_argument("--end")
    parser.add_argument("--calendar-version")
    parser.add_argument("--calendar-profile", type=Path)
    parser.add_argument("--precision", type=int)
    parser.add_argument("--version")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--without-composite-aggregates", action="store_true",
                        help="Use a separate composite aggregate worker; keep legacy default otherwise")
    parser.add_argument("--report", action="store_true")
    args = parser.parse_args()
    bootstrap()
    version_id = args.version
    if args.create:
        if not all((args.start, args.end, args.calendar_version)) or args.precision is None:
            parser.error("Create requires explicit start/end, reviewed calendar version and precision")
        start, end = [int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)
                      for value in (args.start, args.end)]
        from .aggregation_policy import resolve_calendar

        if not args.asset_class:
            parser.error("Create requires --asset-class; indices also require --aggregation-calendar")
        calendar = resolve_calendar(args.asset_class, args.aggregation_calendar)
        if not args.provider_symbol:
            parser.error("Create requires the exact --provider-symbol")
        identity = DatasetIdentity(source="dukascopy", channel="python", environment="historical",
            account_scope="public", provider_symbol=args.provider_symbol,
            basis="bid", calendar_version=args.calendar_version)
        with transaction() as db:
            inst = register_dataset(db, identity, logical_symbol=args.create, label=args.create,
                calendar=calendar, asset_class=args.asset_class, precision=args.precision, volume_kind="quantity",
                volume_unit="source_quantity", calendar_profile=(json.loads(args.calendar_profile.read_text())
                    if args.calendar_profile else None))
            version_id = create_version(db, identity.key, start, end)
            print(json.dumps({"version": version_id, "instrument": inst.id}))
    if args.report:
        with transaction() as db:
            print(json.dumps(version_report(db, version_id)))
        return
    adapter = HistorySources()
    try:
        while True:
            worked = worker_tick(adapter, version_id=version_id,
                without_composite_aggregates=args.without_composite_aggregates)
            if args.once:
                return
            # Every round services all roles with bounded page transactions.
            # Yield briefly under load; there is no one-second per-page floor.
            time.sleep(0.01 if worked else 5)
    finally:
        adapter.close()


if __name__ == "__main__":
    main()
