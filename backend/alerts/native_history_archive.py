"""Period checkpoints and immutable snapshots under the managed history worker.

Only source I/O runs outside transactions. A fixed version owns a single lease;
frame checkpoints never rewrite published input or another worker's results.
"""

import gzip
import hashlib
import json
from datetime import UTC, datetime

from sqlalchemy import select

from .market_contracts import (
    DatasetIdentity,
    MarketRequestError,
    NativeBarRow,
    SourceIdentity,
    failed_request,
)
from .market_datasets import PRICE_RULE_VERSION, process_rows
from .source_history_store import AcquisitionBusy, raw_chunk, shared_native_page, store_blob
from .storage import (
    DatasetFrameSource,
    DatasetMaintenance,
    HistoryChunk,
    HistoryFrameRun,
    HistoryReadAttempt,
    HistoryRun,
    HistoryVersion,
    Instrument,
    MarketDataset,
    SourceBlob,
    SourceSeries,
    now_ms,
    transaction,
    uid,
)

TERMINAL = {"success", "stale", "unavailable", "inherited"}


def create(db, dataset, start, end, *, requested_frames=None, use_frame_targets=False):
    identity = DatasetIdentity.model_validate(dataset.identity)
    if identity.identity_version != 2:
        raise ValueError("Native snapshots require a v2 dataset")
    plan = db.get(DatasetMaintenance, dataset.id)
    outputs = list(plan.timeframes) if plan else None
    bindings = list(db.scalars(select(DatasetFrameSource).where(
        DatasetFrameSource.dataset_id == dataset.id).order_by(DatasetFrameSource.timeframe)))
    selected = ({"D1"} if identity.mode == "base_d1" else set(outputs)) if outputs else {
        binding.timeframe for binding in bindings}
    bindings = [binding for binding in bindings if binding.timeframe in selected]
    if not bindings or selected != {binding.timeframe for binding in bindings}:
        raise ValueError("Selected inputs lack verified source bindings")
    requested = selected if requested_frames is None else set(requested_frames)
    if not requested <= selected:
        raise ValueError("Cannot update a period outside the frozen maintenance selection")
    from .history_maintenance import latest_version

    parent = db.get(HistoryVersion, plan.latest_version_id) if plan and plan.latest_version_id else latest_version(db, dataset.id)
    inst = db.get(Instrument, dataset.instrument_id)
    frame_starts = {binding.timeframe: (
        (plan.frame_plan or {}).get(binding.timeframe, {}).get("target_start", start)
        if use_frame_targets and plan else start) for binding in bindings}
    if any(not 0 <= left < end or left % 60000 for left in frame_starts.values()):
        raise ValueError("周期维护起点必须早于任务截止时间，且为UTC分钟边界")
    left = min(frame_starts.values())
    version = HistoryVersion(dataset_id=dataset.id, start=min(left, parent.start) if parent else left,
        end=max(end, parent.end) if parent else end, cursor=left,
        manifest={"schema": "managed-period-snapshot-v2", "mode": identity.mode,
            "identity": dataset.identity, "input_frames": sorted(selected),
            "output_frames": outputs or (["D1"] if identity.mode == "base_d1" else sorted(selected)),
            "parent_version": parent.id if parent else None,
            "price_precision": inst.precision, "price_rule_version": PRICE_RULE_VERSION})
    db.add(version)
    db.flush()
    for binding in bindings:
        # Providers bound the currently available window. Recheck that window
        # instead of hiding revisions behind an overlap-only refresh.
        frame_start = frame_starts[binding.timeframe]
        db.add(HistoryFrameRun(version_id=version.id, timeframe=binding.timeframe,
            source_id=binding.source_id, start=frame_start, end=end, cursor=frame_start,
            inherited_version_id=parent.id if parent else None,
            status="pending" if binding.timeframe in requested else "inherited", facts={}))
    db.flush()
    return version.id


def _claim(version_id):
    with transaction() as db:
        query = select(HistoryVersion).join(MarketDataset).where(
            MarketDataset.identity["identity_version"].as_integer() == 2,
            HistoryVersion.status.in_(("pending", "running", "retrying")),
            HistoryVersion.lease_until <= now_ms(), HistoryVersion.next_at <= now_ms(),
            ~select(HistoryRun.version_id).where(HistoryRun.version_id == HistoryVersion.id,
                HistoryRun.desired_state != "running").exists())
        if version_id:
            query = query.where(HistoryVersion.id == version_id)
        candidate = db.scalar(query.order_by(HistoryVersion.created_at, HistoryVersion.id)
            .with_for_update(skip_locked=True, of=MarketDataset).limit(1))
        if not candidate:
            return None
        from .history_versions import lock_version

        version = lock_version(db, candidate.id)
        frames = list(db.scalars(select(HistoryFrameRun).where(HistoryFrameRun.version_id == version.id)
                                .order_by(HistoryFrameRun.timeframe)))
        frame = next((row for row in frames if row.status not in TERMINAL and row.retry_at <= now_ms()), None)
        if not frame:
            if all(row.status in TERMINAL for row in frames):
                _publish(db, version, frames)
                return {"published": True}
            version.next_at = min(row.retry_at for row in frames if row.status not in TERMINAL)
            return {"waiting": True}
        version.lease_token, version.lease_until = uid(), now_ms() + 120000
        version.status, frame.status = "running", "running"
        frame.attempts += 1
        source = db.get(SourceSeries, frame.source_id)
        dataset = db.get(MarketDataset, version.dataset_id)
        for pending in db.scalars(select(HistoryReadAttempt).where(
                HistoryReadAttempt.version_id == version.id,
                HistoryReadAttempt.finished_at.is_(None))):
            from .history_request_evidence import finish

            finish(pending, "interrupted")
        attempt = HistoryReadAttempt(id=uid(), version_id=version.id, timeframe=frame.timeframe,
            start=frame.cursor, end=frame.end, started_at=now_ms())
        db.add(attempt)
        db.flush()
        return {"version": version.id, "token": version.lease_token, "frame": frame.timeframe,
            "identity": source.identity, "start": frame.cursor, "end": frame.end,
            "attempt": attempt.id, "fresh_after": version.created_at,
            "precision": db.get(Instrument, dataset.instrument_id).precision,
            "volume_kind": dataset.volume_kind, "volume_unit": dataset.volume_unit}


def _rows_from_pages(db, frame):
    for reference in frame.facts.get("pages", []):
        blob = db.get(SourceBlob, reference)
        raw = gzip.decompress(blob.content)
        if blob.source_id != frame.source_id or hashlib.sha256(raw).hexdigest() != blob.checksum:
            raise ValueError("Native checkpoint source content mismatch")
        yield from json.loads(raw)


def _merge(db, version, frame):
    """Merge by month with one bounded source month in memory; old rows survive."""
    parent_chunks = list(db.scalars(select(HistoryChunk).where(
        HistoryChunk.version_id == frame.inherited_version_id,
        HistoryChunk.timeframe == frame.timeframe).order_by(HistoryChunk.start))) if frame.inherited_version_id else []
    months = {datetime.fromtimestamp(chunk.start / 1000, UTC).strftime("%Y-%m") for chunk in parent_chunks}
    months.update(datetime.fromtimestamp(row["start"] / 1000, UTC).strftime("%Y-%m")
                  for row in _rows_from_pages(db, frame))
    count, first, last, changed = 0, None, None, None
    for month in sorted(months):
        rows = {}
        for chunk in parent_chunks:
            if datetime.fromtimestamp(chunk.start / 1000, UTC).strftime("%Y-%m") == month:
                rows.update((row["start"], row) for row in json.loads(raw_chunk(db, chunk)))
        incoming = [row for row in _rows_from_pages(db, frame)
                    if datetime.fromtimestamp(row["start"] / 1000, UTC).strftime("%Y-%m") == month]
        for row in incoming:
            if row != rows.get(row["start"]):
                changed = min(changed, row["start"]) if changed is not None else row["start"]
            rows[row["start"]] = row
        output = sorted(rows.values(), key=lambda row: row["start"])
        if not output:
            continue
        first = output[0]["start"] if first is None else first
        last = output[-1]["end"]
        count += len(output)
        for offset in range(0, len(output), 4096):
            part = output[offset:offset + 4096]
            raw = json.dumps(part, sort_keys=True, separators=(",", ":")).encode()
            content_id, checksum = store_blob(db, frame.source_id, raw)
            db.add(HistoryChunk(version_id=version.id, timeframe=frame.timeframe,
                start=part[0]["start"], end=part[-1]["end"], count=len(part),
                observed_at=frame.observed_at or 0, checksum=checksum, content_id=content_id,
                content=b"", result="data", unknown=[]))
    return {"rows": count, "first": first, "last": last, "changed_from": changed}


def _publish(db, version, frames):
    dataset = db.get(MarketDataset, version.dataset_id)
    inst = db.get(Instrument, dataset.instrument_id)
    parent = db.get(HistoryVersion, version.manifest.get("parent_version")) if version.manifest.get("parent_version") else None
    plan = db.get(DatasetMaintenance, dataset.id)
    if plan:
        frame_plan = {key: dict(value) for key, value in plan.frame_plan.items()}
        for frame in frames:
            if frame.timeframe not in frame_plan:
                continue
            rule = frame_plan[frame.timeframe]
            if frame.status == "success":
                rule["last_success"] = frame.last_success
            elif frame.status in ("stale", "unavailable"):
                rule["next_due"] = min(rule["next_due"], frame.retry_at)
        plan.frame_plan = frame_plan
        plan.next_at = min(rule["next_due"] for rule in frame_plan.values())
    if not any(frame.status == "success" for frame in frames):
        version.status, version.error = "failed", "all_periods_failed"
        run = db.get(HistoryRun, version.id)
        if run:
            run.completed_at = now_ms()
        plan = db.get(DatasetMaintenance, dataset.id)
        if plan and plan.active_version_id == version.id:
            plan.active_version_id = None
        return
    facts = {}
    for frame in frames:
        inherited = frame.status == "inherited"
        previous = (parent.manifest.get("frames", {}).get(frame.timeframe, {}) if parent else {})
        if frame.status != "success":
            frame.observed_at = previous.get("observed_at")
            frame.last_success = previous.get("last_success")
        merged = _merge(db, version, frame)
        if inherited:
            frame.status = ("stale" if previous.get("status") == "stale" else "success") if merged["rows"] else "unavailable"
            frame.error = previous.get("error")
        elif frame.status in ("stale", "unavailable"):
            frame.status = "stale" if merged["rows"] else "unavailable"
        facts[frame.timeframe] = {**merged, "status": frame.status, "source_id": frame.source_id,
            "target_start": frame.start, "target_end": frame.end, "observed_at": frame.observed_at,
            "last_success": frame.last_success, "error": frame.error,
            "request_count": frame.attempts,
            "inherited_version": frame.inherited_version_id if inherited or frame.status != "success" else None}
    db.flush()
    chunks = list(db.scalars(select(HistoryChunk).where(HistoryChunk.version_id == version.id)
                            .order_by(HistoryChunk.timeframe, HistoryChunk.start)))
    # Verify every reference before freezing the manifest.
    for chunk in chunks:
        raw_chunk(db, chunk)
    version.manifest = {**version.manifest, "frames": facts,
        "result": "partial" if any(f.status in ("stale", "unavailable") for f in frames) else "success",
        "rows": sum(f["rows"] for f in facts.values()), "start": version.start, "end": version.end,
        "volume_kind": dataset.volume_kind, "volume_unit": dataset.volume_unit,
        "asset_class": dataset.asset_class, "aggregation_calendar": inst.calendar,
        "calendar_profile": inst.calendar_profile,
        "checksum": hashlib.sha256("".join(c.timeframe + c.checksum for c in chunks).encode()).hexdigest(),
        "chunks": [{"id": c.id, "timeframe": c.timeframe, "start": c.start,
                    "end": c.end, "checksum": c.checksum, "count": c.count} for c in chunks]}
    from .history_artifacts import request_artifacts
    from .history_maintenance import on_publish
    from .history_request_evidence import snapshot

    version.manifest = {**version.manifest, "request_evidence": snapshot(db, version.id)}
    version.status, version.published_at = "published", now_ms()
    version.lease_token, version.lease_until, version.error = None, 0, None
    on_publish(db, version)
    request_artifacts(db, version, version.manifest["output_frames"])


def import_page(adapter, *, version_id=None):
    owner = _claim(version_id)
    if not owner:
        return False
    if owner.get("published") or owner.get("waiting"):
        return True
    evidence, batch, error = {}, None, None
    accepted = []
    try:
        batch = shared_native_page(adapter, SourceIdentity.model_validate(owner["identity"]),
            owner["start"], owner["end"], fresh_after=owner["fresh_after"],
            volume_kind=owner["volume_kind"], volume_unit=owner["volume_unit"], evidence=evidence)
        if not batch.result.successful:
            raise MarketRequestError(batch.result)
        if not batch.rows:
            raise MarketRequestError(batch.result.model_copy(update={"status": "unavailable"}))
        accepted = process_rows([row.model_dump() for row in batch.rows
            if row.complete and row.end <= min(batch.checkpoint, owner["end"])], owner["precision"])
        accepted = [NativeBarRow.model_validate(row).model_dump() for row in accepted]
    except Exception as caught:
        error = caught
    from .history_request_evidence import finish
    from .history_versions import controlled_stop, lock_version

    with transaction() as db:
        version = lock_version(db, owner["version"])
        attempt = db.get(HistoryReadAttempt, owner["attempt"])
        if (version.lease_token != owner["token"] or version.lease_until <= now_ms()
                or controlled_stop(db, version)):
            finish(attempt, "discarded", read_kind=evidence.get("read_kind"))
            return True
        frame = db.get(HistoryFrameRun, (version.id, owner["frame"]))
        if isinstance(error, AcquisitionBusy):
            frame.status, frame.retry_at = "pending", now_ms() + 1000
            frame.attempts -= 1
            finish(attempt, "shared_busy", read_kind=evidence.get("read_kind"))
        elif error:
            result = failed_request(error, observed_at=now_ms())
            frame.error, frame.status = result.status, "stale" if frame.inherited_version_id else "unavailable"
            frame.retry_at = result.retry_at or now_ms() + 60000
            finish(attempt, result.status, batch=batch, read_kind=evidence.get("read_kind"))
        else:
            if not accepted:
                frame.status, frame.error = "stale" if frame.inherited_version_id else "unavailable", "no_confirmed_bars"
                frame.retry_at = now_ms() + 60000
                finish(attempt, "unavailable", batch=batch, read_kind=evidence.get("read_kind"))
            else:
                raw = json.dumps(accepted, sort_keys=True, separators=(",", ":")).encode()
                blob, _ = store_blob(db, frame.source_id, raw)
                frame.facts = {**frame.facts, "pages": [*frame.facts.get("pages", []), blob]}
                frame.cursor, frame.observed_at = batch.checkpoint, batch.observed_at
                frame.status = "success" if frame.cursor == frame.end else "pending"
                frame.last_success = now_ms() if frame.status == "success" else None
                finish(attempt, "data", batch=batch, accepted=True, read_kind=evidence.get("read_kind"))
        version.lease_token, version.lease_until = None, 0
        version.status, version.next_at = "pending", 0
        db.flush()
    return True
