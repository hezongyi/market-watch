"""Explicit fixed-history and composite inputs shared by business chart routes.

Metadata and searches are pure. An authenticated chart read with a client is
the first-use command for a saved, eligible composite candidate.
"""

import hashlib
import json
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import func, select

from .chart_data import FRAMES, future_grid
from .chart_series import encode
from .composite_definitions import baseline, definition, first_use
from .storage import (
    CompositeMinuteInput,
    CompositeRevision,
    DatasetMaintenance,
    HistoryArtifact,
    HistoryReclamation,
    HistoryVersion,
    Instrument,
    MarketComposite,
    MarketDataset,
    RealtimeMapping,
    now_ms,
)


def composite_definition(db, ident):
    composite = db.get(MarketComposite, ident)
    if composite and composite.permission_scope == "workspace:default":
        return composite.dataset_id, composite.mapping_id, composite
    for mapping in db.scalars(select(RealtimeMapping).where(
            RealtimeMapping.permission_scope == "workspace:default")):
        try:
            facts = definition(db, mapping.dataset_id, mapping.id)
        except ValueError:
            continue
        if facts[-1] == ident:
            return mapping.dataset_id, mapping.id, None
    raise ValueError("组合身份不存在或映射已不属于当前账户")


def metadata(db, ident, kind):
    if kind == "history":
        version = db.get(HistoryVersion, ident)
        if not version or version.status != "published" or db.get(HistoryReclamation, ident):
            raise ValueError("固定历史版本不存在、尚未发布或已回收")
        dataset = db.get(MarketDataset, version.dataset_id)
        inst = db.get(Instrument, dataset.instrument_id)
        frames = list(db.scalars(select(HistoryArtifact.timeframe).where(
            HistoryArtifact.version_id == version.id, HistoryArtifact.status == "published",
            HistoryArtifact.count > 0)))
        if not frames:
            raise ValueError("固定历史周期产物尚未发布")
        binding = {"version_id": version.id, "history_version_id": version.id,
                   "dataset_id": dataset.id, "history_checksum": version.manifest["checksum"]}
        volume_kind, volume_unit = dataset.volume_kind, dataset.volume_unit
    elif kind == "composite":
        dataset_id, mapping_id, composite = composite_definition(db, ident)
        dataset = db.get(MarketDataset, dataset_id)
        inst = db.get(Instrument, dataset.instrument_id)
        mapping = db.get(RealtimeMapping, mapping_id)
        target = db.get(Instrument, db.get(MarketDataset, mapping.target_dataset_id).instrument_id)
        if composite:
            revision = db.get(CompositeRevision, composite.active_revision_id)
            version = db.get(HistoryVersion, revision.history_version_id)
            seam = revision.seam
        else:
            version, seam = baseline(db, dataset.id, inst.calendar)
        frames = FRAMES
        binding = {"composite_id": ident, "dataset_id": dataset.id, "mapping_id": mapping_id,
                   "history_version_id": version.id, "seam": seam, "created": composite is not None}
        # A mixed-source volume is not a uniform quantity for this series.
        volume_kind, volume_unit = "unavailable", None
    else:
        raise ValueError("需要明确的固定历史或组合行情类型")
    return {"id": ident, "symbol": dataset.logical_symbol, "name": inst.label,
        "series_kind": kind, "source": dataset.identity["source"] if kind == "history" else "composite",
        "historical_source": dataset.identity["source"], "basis": inst.basis,
        "calendar": inst.calendar, "precision": max(inst.precision, target.precision) if kind == "composite" else inst.precision,
        "frames": [frame for frame in FRAMES if frame in frames], "volume_kind": volume_kind,
        "volume_unit": volume_unit, **binding}


def chart_data(db, body):
    from .composite_chart import chart_page as composite_page
    from .history_artifacts import chart_page as history_page
    from .market_data import renew_demand

    stamp = now_ms()
    meta = metadata(db, body.instrument, body.series_kind)
    if body.series_kind == "history":
        parent = db.get(HistoryVersion, body.instrument)
        page = history_page(db, parent.id, body.timeframe, before=body.before, count=body.limit)
        page.update(has_more=page["next_before"] is not None, origin=parent.start,
            history_revision=hashlib.sha256(json.dumps([parent.manifest["checksum"], body.timeframe]).encode()).hexdigest(),
            pending=[], input_manifest={"version_id": parent.id, "checksum": parent.manifest["checksum"]})
        inst = db.get(Instrument, db.get(MarketDataset, parent.dataset_id).instrument_id)
    else:
        dataset, mapping, composite = composite_definition(db, body.instrument)
        if body.client:
            composite = first_use(db, dataset, mapping)
            if composite.id != body.instrument:
                raise ValueError("首次使用身份与候选不一致")
        if not composite:
            raise ValueError("组合尚未建立；请从图表实际使用入口打开")
        page = composite_page(db, composite.id, body.timeframe, before=body.before, count=body.limit,
            revision_id=body.composite_revision_id, input_revision=body.input_revision,
            provisional=body.provisional and body.input_revision is None, now=stamp)
        inst = db.get(Instrument, composite.instrument_id)
        if body.client:
            renew_demand(db, body.client, inst)
    for bar in page["bars"]:
        at = bar["end"] - 1 if body.timeframe == "D1" else bar["start"] + (
            86400000 if meta["calendar"] == "ny17" else 0)
        if body.timeframe in ("D1", "W1", "MN"):
            date = datetime.fromtimestamp(at / 1000, ZoneInfo("America/New_York") if meta["calendar"] == "ny17" else timezone.utc).date()
            if body.timeframe == "MN":
                date = date.replace(day=1)
            bar["chart_time"] = int(datetime.combine(date, datetime.min.time(), timezone.utc).timestamp() * 1000)
    indicators, indicator_progress = [], []
    if body.indicators:
        from .fixed_indicators import chart_results

        indicators, indicator_progress = chart_results(db, page, body.indicators,
            provisional=body.provisional and body.input_revision is None, stamp=stamp)
        if any(item["status"] != "complete" for item in indicator_progress):
            page["pending"].append("指标正在从固定输入起点初始化或修复；已计算区间可读，未完成区间不截断预热")
    page["indicator_progress"] = indicator_progress
    if indicator_progress:
        page["history_revision"] = hashlib.sha256(json.dumps([page["history_revision"],
            [[item["run_id"], item["cursor"]] for item in indicator_progress]], sort_keys=True).encode()).hexdigest()
    check = history_check(db, page, body, meta)
    return {**page, "history_check": check, "basis": meta["basis"], "calendar": meta["calendar"], "precision": meta["precision"],
        "volume_kind": meta["volume_kind"], "volume_unit": meta["volume_unit"],
        "indicators": indicators, "indicator_progress": indicator_progress,
        "future": future_grid(inst, body.timeframe, page["bars"][-1]["end"]) if page["bars"] else [],
        "bounded_history": True, "as_of": stamp, "series_kind": body.series_kind, "symbol": meta["symbol"]}


def history_check(db, page, body, meta):
    """Index-backed correction stamp for loaded closed buckets, excluding tail appends.

    The max immutable input revision in a bounded prefix changes on any accepted
    correction or gap fill there. Changes in the forming/latest bucket stay on
    the realtime path. No long M1 history reconstruction is needed to poll.
    """
    if not body.track_history or not page["bars"]:
        return None
    from .composite_series import period

    next_before = page["bars"][-1]["start"]
    before = body.revision_before or next_before
    # Recursive dependencies include the fixed prefix preceding visible prices.
    # Corrections there must reset studies even if loaded OHLC is unchanged.
    after = page["origin"] if body.indicators else body.revision_after

    def fingerprint(boundary):
        if body.series_kind == "history":
            facts = [page["input_manifest"], page["rule_version"], body.timeframe]
        else:
            # A minute correction in the excluded bucket must not invalidate
            # earlier buckets merely because its minute precedes a UTC label.
            cutoff = period(boundary, body.timeframe, meta["calendar"])[0]
            floor = period(after, body.timeframe, meta["calendar"])[0] if after is not None else 0
            changed = db.scalar(select(func.max(CompositeMinuteInput.input_revision)).where(
                CompositeMinuteInput.revision_id == page["revision_id"],
                CompositeMinuteInput.input_revision <= page["input_revision"],
                CompositeMinuteInput.start >= max(0, floor), CompositeMinuteInput.start < cutoff))
            facts = [page["revision_id"], page["history_version_id"], page["rule_version"],
                     body.timeframe, changed or 0]
        if body.indicators:
            from .indicator_state import ALGORITHM

            facts += [ALGORITHM, body.indicators,
                      [min(item["cursor"], boundary) for item in page.get("indicator_progress", [])]]
        return hashlib.sha256(json.dumps(facts, sort_keys=True).encode()).hexdigest()

    revision = fingerprint(before)
    return {"before": before, "after": after, "revision": revision, "next_before": next_before,
            "next_revision": revision if next_before == before else fingerprint(next_before)}


def export_page(db, body):
    """Export one fixed input snapshot without maintenance or first-use demand."""
    from fastapi import HTTPException

    from .chart_api import DataQuery

    before, bars, indicators = body.end, [], {}
    revision, inputs = body.composite_revision_id, body.input_revision
    for _ in range(32):
        page = chart_data(db, DataQuery(instrument=body.instrument, series_kind=body.series_kind,
            timeframe=body.timeframe, before=before, limit=2000, indicators=body.indicators,
            provisional=False, composite_revision_id=revision, input_revision=inputs))
        if page.get("pending"):
            # Return the pending command result so the enclosing transaction
            # commits indicator requests; raising here would roll them back.
            return {**page, "export_pending": True}
        if body.series_kind == "composite":
            revision, inputs = page["revision_id"], page["input_revision"]
        bars = [bar for bar in page["bars"] if body.start <= bar["start"] < body.end] + bars
        for indicator in page["indicators"]:
            old = indicators.setdefault(indicator["id"], {**indicator, "series": [
                {**series, "values": []} for series in indicator["series"]]})
            for series, accumulated in zip(indicator["series"], old["series"]):
                accumulated["values"] = [value for value in series["values"]
                    if body.start <= value["time"] < body.end] + accumulated["values"]
        if len(bars) > 2000:
            raise HTTPException(413, "单次最多导出2000根K线，请缩小日期范围")
        cursor = page["next_before"]
        if cursor is None or cursor <= body.start:
            return {**page, "bars": bars, "indicators": list(indicators.values())}
        if cursor >= before:
            raise ValueError("行情导出分页没有推进")
        before = cursor
    raise HTTPException(413, "单次导出分页过多，请缩小日期范围")


def search(db, query="", *, kind="all", limit=100):
    """No registration, demand, supplier requests, or mutable-version fallback."""
    if kind not in ("all", "history", "composite") or not 1 <= limit <= 250:
        raise ValueError("无效行情搜索范围")
    results = []
    term = query.strip().upper()
    datasets = db.scalars(select(MarketDataset).where(~select(DatasetMaintenance.dataset_id).where(
        DatasetMaintenance.dataset_id == MarketDataset.id, DatasetMaintenance.archived.is_(True)).exists())
                         .order_by(MarketDataset.logical_symbol, MarketDataset.id))
    for dataset in datasets:
        inst = db.get(Instrument, dataset.instrument_id)
        if term not in (dataset.logical_symbol + inst.label + dataset.identity["provider_symbol"]).upper():
            continue
        if kind in ("all", "history"):
            versions = db.scalars(select(HistoryVersion).where(HistoryVersion.dataset_id == dataset.id,
                HistoryVersion.status == "published", ~select(HistoryReclamation.version_id).where(
                    HistoryReclamation.version_id == HistoryVersion.id).exists())
                .order_by(HistoryVersion.published_at.desc(), HistoryVersion.id.desc()))
            for version in versions:
                try:
                    meta = metadata(db, version.id, "history")
                except ValueError:
                    continue
                results.append({**meta, "ticker": encode(version.id, "history"), "label": inst.label,
                    "description": f"自建 · {dataset.identity['source']} · {inst.basis} · {inst.calendar} · 固定发布",
                    "available": True})
                break
        if kind in ("all", "composite"):
            mappings = db.scalars(select(RealtimeMapping).where(RealtimeMapping.dataset_id == dataset.id,
                RealtimeMapping.permission_scope == "workspace:default")
                .order_by(RealtimeMapping.created_at.desc(), RealtimeMapping.id))
            for mapping in mappings:
                try:
                    ident = definition(db, dataset.id, mapping.id)[-1]
                    meta = metadata(db, ident, "composite")
                except ValueError:
                    continue
                results.append({**meta, "ticker": encode(ident, "composite"), "label": inst.label,
                    "description": f"组合 · {dataset.identity['source']}→OANDA Practice · {inst.basis} · {inst.calendar}",
                    "available": True})
        if len(results) >= limit:
            break
    return results[:limit]
