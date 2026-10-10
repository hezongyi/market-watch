"""Restartable per-period artifacts over one immutable parent M1 version.

Each transaction reads at most 5,000 M1 observations; a long bucket persists only
OHLC/volume/count state. Coverage and source confirmation remain distinct facts.
"""

import gzip
import hashlib
import json
from decimal import Decimal

from sqlalchemy import select

from .calendar_profile import closures_from
from .chart_data import FRAMES, bounds
from .chart_series import is_gold
from .domain import bucket_bounds, calendar_for, scheduled_open
from .source_history_store import raw_chunk
from .market_datasets import process_rows
from .storage import (
    HistoryArtifact,
    HistoryArtifactBlock,
    HistoryChunk,
    HistoryReclamation,
    HistoryRun,
    HistoryVersion,
    Instrument,
    MarketDataset,
    instant,
    ms,
    now_ms,
    transaction,
)

RULE_VERSION = "configured-phase-m1-v1"


def request_artifacts(db, version, frames):
    if not frames or any(f not in FRAMES for f in frames):
        raise ValueError("请选择支持的自建周期")
    if version.status != "published":
        raise ValueError("周期产物需要已发布M1父版本")
    db.scalar(select(MarketDataset).where(MarketDataset.id == version.dataset_id).with_for_update())
    if db.get(HistoryReclamation, version.id):
        raise ValueError("历史版本价格数据已回收，不能重新派生产物")
    from sqlalchemy.dialects.postgresql import insert as postgres_insert
    from sqlalchemy.dialects.sqlite import insert as sqlite_insert

    insert = postgres_insert if db.get_bind().dialect.name == "postgresql" else sqlite_insert
    for frame in set(frames):
        key = hashlib.sha256(f"{version.id}|{frame}|{RULE_VERSION}".encode()).hexdigest()
        db.execute(insert(HistoryArtifact).values(id=key, version_id=version.id, timeframe=frame,
            rule_version=RULE_VERSION, status="pending", cursor=version.start,
            accumulator={}, count=0, complete_count=0, manifest={})
            .on_conflict_do_nothing(index_elements=["version_id", "timeframe"]))


def _pair(at, frame, instrument):
    if frame == "M1":
        return at, at + 60000
    calendar = calendar_for(instrument)
    func = bounds if frame in ("M30", "W1", "MN") else bucket_bounds
    left, right = func(instant(at), frame, calendar)
    return ms(left), ms(right)


def _add(state, row, instrument):
    at = row["timestamp"]
    calendar, closures = calendar_for(instrument), closures_from(instrument.calendar_profile)
    if not state.get("observed"):
        state.update(open=row["open"], high=row["high"], low=row["low"], close=row["close"],
            volume="0", volume_present=True, observed=0, source_confirmed=True, conflict=False)
    state["high"] = str(max(Decimal(state["high"]), Decimal(row["high"])))
    state["low"] = str(min(Decimal(state["low"]), Decimal(row["low"])))
    state["close"], state["observed"] = row["close"], state["observed"] + 1
    state["source_confirmed"] &= row["complete"]
    state["conflict"] |= not scheduled_open(instant(at), calendar, gold=is_gold(instrument.id), closures=closures)
    if row["volume"] is None:
        state["volume_present"] = False
    else:
        state["volume"] = str(Decimal(state["volume"]) + Decimal(row["volume"]))


def _finish(state, instrument, version, dataset):
    if not state or not state.get("observed"):
        return None
    calendar, closures = calendar_for(instrument), closures_from(instrument.calendar_profile)
    left, right = state["start"], state["end"]
    expected = (right - left) // 60000 if state["conflict"] else sum(
        scheduled_open(instant(at), calendar, gold=is_gold(instrument.id), closures=closures)
        for at in range(left, right, 60000))
    coverage = state["observed"] == expected and version.start <= left and right <= version.end
    time_closed = right <= version.end
    complete = coverage and time_closed and state["source_confirmed"]
    return {"start": left, "end": right, **{key: state[key] for key in ("open", "high", "low", "close")},
        "volume": state["volume"] if state["volume_present"] and coverage else None,
        "volume_complete": complete and state["volume_present"], "complete": complete,
        "time_closed": time_closed, "source_confirmed": state["source_confirmed"],
        "coverage_complete": coverage, "observed_minutes": state["observed"], "expected_minutes": expected,
        "session_conflict": state["conflict"], "volume_kind": dataset.volume_kind,
        "volume_unit": dataset.volume_unit, "parent_version_id": version.id, "rule_version": RULE_VERSION}


def _reuse_period_block(db, artifact, version):
    """Reuse unchanged complete buckets without aggregating their M1 again."""
    if artifact.accumulator:
        return None
    run = db.get(HistoryRun, version.id)
    if not run or not run.parent_version_id:
        return None
    parent = db.get(HistoryVersion, run.parent_version_id)
    if not parent.start <= artifact.cursor < parent.end:
        return None
    previous = db.scalar(select(HistoryArtifact).where(HistoryArtifact.version_id == parent.id,
        HistoryArtifact.timeframe == artifact.timeframe, HistoryArtifact.status == "published",
        HistoryArtifact.rule_version == artifact.rule_version))
    if not previous:
        return None
    block = db.scalar(select(HistoryArtifactBlock).where(HistoryArtifactBlock.artifact_id == previous.id,
        HistoryArtifactBlock.start >= artifact.cursor).order_by(HistoryArtifactBlock.start).limit(1))
    if not block or block.end > min(parent.end, version.end):
        return None
    if artifact.cursor < run.refresh_end and block.end > run.refresh_start:
        return None
    raw = gzip.decompress(block.content)
    if hashlib.sha256(raw).hexdigest() != block.checksum:
        raise ValueError("Original timeframe artifact checksum mismatch")
    return [{**row, "parent_version_id": version.id} for row in json.loads(raw)], block.end


def artifact_tick(version_id=None):
    with transaction() as db:
        query = select(HistoryArtifact).where(HistoryArtifact.status == "pending")
        query = query.where(~select(HistoryRun.version_id).where(
            HistoryRun.version_id == HistoryArtifact.version_id,
            HistoryRun.desired_state != "running").exists())
        if version_id:
            query = query.where(HistoryArtifact.version_id == version_id)
        artifact = db.scalar(query.order_by(HistoryArtifact.version_id, HistoryArtifact.timeframe)
            .with_for_update(skip_locked=True).limit(1))
        if not artifact:
            return False
        version = db.get(HistoryVersion, artifact.version_id)
        if version.status != "published":
            raise ValueError("Immutable artifact parent is not published")
        dataset = db.get(MarketDataset, version.dataset_id)
        instrument = db.get(Instrument, dataset.instrument_id)
        state, output = dict(artifact.accumulator), []
        reused = _reuse_period_block(db, artifact, version)
        chunk = None if reused else db.scalar(select(HistoryChunk).where(HistoryChunk.version_id == version.id,
            HistoryChunk.end > artifact.cursor).order_by(HistoryChunk.start).limit(1))
        if reused:
            output, artifact.cursor = reused
        elif chunk:
            if chunk.start > artifact.cursor:
                raise ValueError("Artifact parent query partition is discontinuous")
            source_rows = json.loads(raw_chunk(db, chunk))
            manifest = version.manifest or {}
            if manifest.get("price_rule_version"):
                source_rows = process_rows(source_rows, manifest["price_precision"])
            rows = [r for r in source_rows
                    if r["timestamp"] >= artifact.cursor]
            page = rows[:5000]
            stop = page[-1]["timestamp"] + 60000 if len(rows) > 5000 else chunk.end
            for row in page:
                left, right = _pair(row["timestamp"], artifact.timeframe, instrument)
                if state and state["start"] != left:
                    output.append(_finish(state, instrument, version, dataset))
                    state = {}
                if not state:
                    state = {"start": left, "end": right}
                _add(state, row, instrument)
            artifact.cursor = stop
        if artifact.cursor == version.end:
            if state:
                output.append(_finish(state, instrument, version, dataset))
                state = {}
        if output:
            raw = json.dumps(output, sort_keys=True, separators=(",", ":")).encode()
            db.add(HistoryArtifactBlock(artifact_id=artifact.id, start=output[0]["start"], end=output[-1]["end"],
                count=len(output), checksum=hashlib.sha256(raw).hexdigest(), content=gzip.compress(raw, mtime=0)))
            artifact.count += len(output)
            artifact.complete_count += sum(row["complete"] for row in output)
        artifact.accumulator = state
        db.flush()
        if artifact.cursor == version.end:
            blocks = db.scalars(select(HistoryArtifactBlock).where(HistoryArtifactBlock.artifact_id == artifact.id)
                .order_by(HistoryArtifactBlock.start)).all()
            artifact.manifest = {"parent_version_id": version.id, "parent_checksum": version.manifest["checksum"],
                "timeframe": artifact.timeframe, "rule_version": RULE_VERSION, "aggregation_calendar": instrument.calendar,
                "identity": dataset.identity, "rows": artifact.count, "complete_rows": artifact.complete_count,
                "blocks": [{"id": b.id, "start": b.start, "end": b.end, "count": b.count,
                            "checksum": b.checksum} for b in blocks],
                "checksum": hashlib.sha256("".join(b.checksum for b in blocks).encode()).hexdigest()}
            artifact.status, artifact.published_at = "published", now_ms()
        completed_version_id = version.id
    from .history_maintenance import finish_run

    with transaction() as db:
        finish_run(db, completed_version_id)
    return True


def artifact_report(db, version_id):
    return [{"id": a.id, "version_id": a.version_id, "timeframe": a.timeframe, "status": a.status, "cursor": a.cursor,
        "rows": a.count, "complete_rows": a.complete_count, "manifest": a.manifest}
        for a in db.scalars(select(HistoryArtifact).where(HistoryArtifact.version_id == version_id)
                           .order_by(HistoryArtifact.timeframe))]


def published_artifact(db, version_id, frame):
    """Lock payload lifetime and validate the immutable parent/period contract."""
    parent = db.get(HistoryVersion, version_id)
    if not parent:
        raise ValueError("历史版本不存在")
    db.scalar(select(MarketDataset.id).where(MarketDataset.id == parent.dataset_id)
              .with_for_update(read=True))
    if db.get(HistoryReclamation, version_id):
        raise ValueError("历史版本价格数据已回收")
    artifact = db.scalar(select(HistoryArtifact).where(HistoryArtifact.version_id == version_id,
                                                      HistoryArtifact.timeframe == frame))
    if not artifact or artifact.status != "published":
        raise ValueError(f"{frame} 该周期产物尚未发布，请在数据中心准备该版本周期")
    manifest = artifact.manifest
    if (parent.status != "published" or manifest.get("parent_version_id") != version_id
            or manifest.get("parent_checksum") != parent.manifest.get("checksum")
            or manifest.get("timeframe") != frame or manifest.get("rule_version") != artifact.rule_version):
        raise ValueError("Published timeframe artifact parent/manifest mismatch")
    return artifact


def iter_artifact(db, version_id, frame, *, start=None, end=None, newest_first=False):
    """Stream verified immutable period blocks; at most one block in memory."""
    artifact = published_artifact(db, version_id, frame)
    query = select(HistoryArtifactBlock).where(HistoryArtifactBlock.artifact_id == artifact.id)
    if start is not None:
        query = query.where(HistoryArtifactBlock.end > start)
    if end is not None:
        query = query.where(HistoryArtifactBlock.start < end)
    ordering = HistoryArtifactBlock.start.desc() if newest_first else HistoryArtifactBlock.start
    for block in db.scalars(query.order_by(ordering).execution_options(yield_per=1)):
        raw = gzip.decompress(block.content)
        if hashlib.sha256(raw).hexdigest() != block.checksum:
            raise ValueError("Published timeframe artifact checksum mismatch")
        rows = json.loads(raw)
        for row in reversed(rows) if newest_first else rows:
            if (start is None or row["start"] >= start) and (end is None or row["start"] < end):
                yield row


def read_artifact(db, version_id, frame, *, start=None, end=None, limit=2000, newest_first=False):
    if not 1 <= limit <= 20000:
        raise ValueError("周期查询数量必须是1–20000")
    from itertools import islice

    output = list(islice(iter_artifact(db, version_id, frame, start=start, end=end,
                                     newest_first=newest_first), limit))
    return output[::-1] if newest_first else output


def chart_page(db, version_id, frame, *, before=None, count=2000):
    """Index-backed fixed-version chart pagination, including partial last bars."""
    if not 1 <= count <= 5000 or before is not None and before < 0:
        raise ValueError("无效的历史图表分页范围")
    rows = read_artifact(db, version_id, frame, end=before, limit=count + 1, newest_first=True)
    more = len(rows) > count
    bars = rows[-count:]
    return {"version_id": version_id, "timeframe": frame, "bars": bars,
            "next_before": bars[0]["start"] if more else None,
            "rule_version": RULE_VERSION}
