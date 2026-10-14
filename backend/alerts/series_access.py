"""Explicit fixed-history and composite inputs shared by business chart routes.

Metadata and searches are pure. An authenticated chart read with a client is
the first-use command for a saved, eligible composite candidate.
"""

import hashlib
import json
from datetime import datetime, timezone
from itertools import zip_longest
from types import SimpleNamespace
from zoneinfo import ZoneInfo

from sqlalchemy import func, or_, select

from .chart_data import FRAMES, future_grid
from .chart_series import encode
from .composite_definitions import baseline, definition, first_use
from .market_names import code_search, display_code, pair_query
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
        revision = db.get(CompositeRevision, composite.active_revision_id)
        return db.get(HistoryVersion, revision.history_version_id).dataset_id, revision.mapping_id, composite
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
    return _metadata(db, ident, kind)


def _metadata(db, ident, kind, *, composite_context=None):
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
        dataset_id, mapping_id, composite = composite_context or composite_definition(db, ident)
        dataset = db.get(MarketDataset, dataset_id)
        inst = db.get(Instrument, dataset.instrument_id)
        if composite:
            revision = db.get(CompositeRevision, composite.active_revision_id)
            version = db.get(HistoryVersion, revision.history_version_id)
            dataset = db.get(MarketDataset, version.dataset_id)
            inst = db.get(Instrument, dataset.instrument_id)
            mapping_id = revision.mapping_id
            seam = revision.seam
        else:
            version, seam = baseline(db, dataset.id, inst.calendar)
        mapping = db.get(RealtimeMapping, mapping_id)
        target = db.get(Instrument, db.get(MarketDataset, mapping.target_dataset_id).instrument_id)
        frames = FRAMES
        binding = {"composite_id": ident, "dataset_id": dataset.id, "mapping_id": mapping_id,
                   "history_version_id": version.id, "seam": seam, "created": composite is not None}
        # A mixed-source volume is not a uniform quantity for this series.
        volume_kind, volume_unit = "unavailable", None
    else:
        raise ValueError("需要明确的固定历史或组合行情类型")
    return {"id": ident, "symbol": dataset.logical_symbol, "name": inst.label,
        "display_symbol": display_code(dataset.logical_symbol, asset_type=dataset.asset_class),
        "series_kind": kind, "source": dataset.identity["source"] if kind == "history" else "composite",
        "historical_source": dataset.identity["source"], "basis": inst.basis,
        "calendar": revision.rules["aggregation_calendar"] if kind == "composite" and composite else inst.calendar,
        "precision": max(inst.precision, target.precision) if kind == "composite" else inst.precision,
        "frames": [frame for frame in FRAMES if frame in frames], "volume_kind": volume_kind,
        "volume_unit": volume_unit, **binding}


def chart_data(db, body, *, realtime=None):
    from .composite_chart import chart_page as composite_page
    from .history_artifacts import chart_page as history_page
    from .market_data import renew_demand

    meta = metadata(db, body.instrument, body.series_kind)
    if body.series_kind == "composite":
        from .config import settings
        from .live_pricing import account_key
        from .storage import LiveState, PricingOwner

        composite = db.get(MarketComposite, body.instrument)
        if composite:
            selected = db.get(CompositeRevision, body.composite_revision_id or composite.active_revision_id)
            if not selected or selected.composite_id != composite.id:
                raise ValueError("组合修订不属于当前组合")
            mapping = db.get(RealtimeMapping, selected.mapping_id)
            # Strong references keep SQLAlchemy's weak identity map on this
            # source observation throughout the history/aggregation read.
            _live_observation = (db.get(LiveState, mapping.target_dataset_id),
                                 db.get(PricingOwner, account_key(settings.oanda_account_id)))
            # First-use adoption needs a write lock. Take it before a shared
            # read lock; two first readers cannot safely upgrade together.
            if _live_observation[0]:
                from .display_observations import handover_legacy

                handover_legacy(db, _live_observation[0])
            db.scalar(select(LiveState).where(LiveState.dataset_id == mapping.target_dataset_id)
                .with_for_update(read=True).execution_options(populate_existing=True))
    # Evaluate freshness after the source snapshot, never before IO that can
    # read a newly received quote and mistake it for future data.
    stamp = now_ms()
    if body.series_kind == "history":
        parent = db.get(HistoryVersion, body.instrument)
        page = history_page(db, parent.id, body.timeframe, before=body.before, count=body.limit)
        page.update(has_more=page["next_before"] is not None, origin=parent.start,
            history_revision=hashlib.sha256(json.dumps([parent.manifest["checksum"], body.timeframe]).encode()).hexdigest(),
            pending=[], input_manifest={"version_id": parent.id, "checksum": parent.manifest["checksum"]})
        inst = db.get(Instrument, db.get(MarketDataset, parent.dataset_id).instrument_id)
    else:
        dataset, mapping, composite = composite_definition(db, body.instrument)
        if body.client and not composite:
            composite = first_use(db, dataset, mapping)
            if composite.id != body.instrument:
                raise ValueError("首次使用身份与候选不一致")
        if not composite:
            raise ValueError("组合尚未建立；请从图表实际使用入口打开")
        snapshot = None
        if body.display_snapshot_id:
            from .display_snapshots import resolve

            if not body.provisional or body.input_revision is not None:
                raise ValueError('展示快照必须按展示模式读取；固定确认输入请使用 input_revision')
            selected = db.get(CompositeRevision, body.composite_revision_id or composite.active_revision_id)
            snapshot = resolve(db, body.display_snapshot_id, selected, body.timeframe, stamp)
        page = composite_page(db, composite.id, body.timeframe, before=body.before, count=body.limit,
            revision_id=body.composite_revision_id, input_revision=body.input_revision,
            provisional=body.provisional and body.input_revision is None, now=stamp, realtime=realtime,
            display_snapshot=snapshot)
        selected = db.get(CompositeRevision, page["revision_id"])
        parent = db.get(HistoryVersion, selected.history_version_id)
        meta["calendar"] = selected.rules["aggregation_calendar"]
        meta["history_version_id"], meta["mapping_id"] = parent.id, selected.mapping_id
        meta["dataset_id"], meta["seam"] = parent.dataset_id, selected.seam
        target_inst = db.get(Instrument, db.get(MarketDataset, db.get(RealtimeMapping, selected.mapping_id).target_dataset_id).instrument_id)
        inst = SimpleNamespace(id=composite.instrument_id, calendar=meta["calendar"], calendar_profile=target_inst.calendar_profile)
        if body.client:
            renew_demand(db, body.client, db.get(Instrument, composite.instrument_id),
                         composite_revision_id=selected.id)
    for bar in page["bars"]:
        if body.timeframe in ("D1", "W1", "MN"):
            bar["chart_time"] = fixed_label(bar, body.timeframe, meta["calendar"])
    indicators, indicator_progress = [], []
    if body.indicators:
        from .fixed_indicators import chart_results

        indicators, indicator_progress = chart_results(db, page, body.indicators,
            provisional=body.provisional and body.input_revision is None, stamp=stamp, display_retry=body.display_retry)
        if any(item["status"] != "complete" for item in indicator_progress):
            page["pending"].append("指标正在从固定输入起点初始化或修复；已计算区间可读，未完成区间不截断预热")
    page["indicator_progress"] = indicator_progress
    if indicator_progress:
        page["history_revision"] = hashlib.sha256(json.dumps([page["history_revision"],
            [[item["run_id"], item["cursor"]] for item in indicator_progress]], sort_keys=True).encode()).hexdigest()
    check = history_check(db, page, body, meta)
    dependency = history_check(db, page, body.model_copy(update={"indicators": [],
        "track_history": True, "revision_before": body.dependency_before,
        "revision_after": page["origin"]}), meta) if body.dependency_before else None
    return {**page, "history_check": check, "basis": meta["basis"], "calendar": meta["calendar"], "precision": meta["precision"],
        "volume_kind": meta["volume_kind"], "volume_unit": meta["volume_unit"],
        "indicators": indicators, "indicator_progress": indicator_progress,
        "dependency_before": body.dependency_before,
        "dependency_revision": dependency["revision"] if dependency else None,
        "future": future_grid(inst, body.timeframe, page["bars"][-1]["end"]) if page["bars"] else [],
        "bounded_history": True, "as_of": stamp, "series_kind": body.series_kind, "symbol": meta["symbol"]}


def fixed_label(bar, frame, phase):
    if frame not in ("D1", "W1", "MN"):
        return bar["start"]
    at = bar["end"] - 1 if frame == "D1" else bar["start"] + (86400000 if phase == "ny17" else 0)
    date = datetime.fromtimestamp(at / 1000, ZoneInfo("America/New_York") if phase == "ny17" else timezone.utc).date()
    if frame == "MN":
        date = date.replace(day=1)
    return int(datetime.combine(date, datetime.min.time(), timezone.utc).timestamp() * 1000)


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


def search_page(db, query="", *, kind="history", page_size=25, offset=0, source=None, calendar=None, symbol_type=""):
    """Bounded SQL qualification then exact metadata; never scan every snapshot.

    Offset advances through candidates, including invalid seam/account entries.
    At most 500 are inspected per request. Unknown qualification totals are not
    presented as counts of usable series; an empty page can still continue.
    """
    from .search_types import TYPES
    if (symbol_type not in TYPES or kind not in ("history", "composite") or not 1 <= page_size <= 250 or not 0 <= offset <= 1000000
            or source not in (None, "dukascopy", "oanda", "binance") or calendar not in (None, "ny17", "utc0")):
        raise ValueError("无效行情搜索范围或筛选")
    eligible_period = select(HistoryArtifact.id).where(HistoryArtifact.version_id == HistoryVersion.id,
        HistoryArtifact.status == "published", HistoryArtifact.count > 0)
    if kind == "composite":
        eligible_period = eligible_period.where(HistoryArtifact.timeframe == "M1")
    versions = select(HistoryVersion.id.label("version_id"), HistoryVersion.dataset_id,
        func.row_number().over(partition_by=HistoryVersion.dataset_id,
            order_by=(HistoryVersion.published_at.desc(), HistoryVersion.id.desc())).label("position"))
    versions = versions.where(HistoryVersion.status == "published", eligible_period.exists(),
        ~select(HistoryReclamation.version_id).where(HistoryReclamation.version_id == HistoryVersion.id).exists()).subquery()
    query_ids = select(MarketDataset.id.label("dataset_id"), versions.c.version_id,
        Instrument.source.label("source"), MarketDataset.logical_symbol.label("symbol"))
    query_ids = query_ids.select_from(MarketDataset).join(Instrument).join(versions, (versions.c.dataset_id == MarketDataset.id) & (versions.c.position == 1))
    query_ids = query_ids.where(~select(DatasetMaintenance.dataset_id).where(
        DatasetMaintenance.dataset_id == MarketDataset.id, DatasetMaintenance.archived.is_(True)).exists(),
        code_search(query, MarketDataset.logical_symbol, Instrument.label, Instrument.symbol,
            MarketDataset.identity["provider_symbol"].as_string()))
    if symbol_type:
        query_ids = query_ids.where(MarketDataset.asset_class == {"commodity": "metal", "stock": "equity", "fund": "etf", "futures": "future"}.get(symbol_type, symbol_type))
    if source:
        query_ids = query_ids.where(Instrument.source == source)
    if calendar and kind == "history":
        query_ids = query_ids.where(Instrument.calendar == calendar)
    if kind == "composite":
        from sqlalchemy.orm import aliased

        from .history_catalog import account_scope
        target = aliased(MarketDataset)
        query_ids = query_ids.add_columns(RealtimeMapping.id.label("mapping_id")).join(RealtimeMapping,
            RealtimeMapping.dataset_id == MarketDataset.id).join(target, target.id == RealtimeMapping.target_dataset_id).where(
                RealtimeMapping.permission_scope == "workspace:default",
                target.identity["account_scope"].as_string() == account_scope())
    else:
        from sqlalchemy import literal
        query_ids = query_ids.add_columns(literal("").label("mapping_id"))
    from sqlalchemy import case
    term = pair_query(query) or query[:100].strip().upper()
    code = func.upper(Instrument.symbol)
    logical = func.upper(MarketDataset.logical_symbol)
    exact = or_(code == term, logical == term, func.replace(func.replace(code, "_", ""), "/", "") == term)
    prefix = query[:100].strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    query_ids = query_ids.add_columns(case((exact, 0), (Instrument.symbol.ilike(prefix, escape="\\"), 1), else_=2).label("match_rank"))
    candidates = query_ids.subquery()
    # Source interleaving happens before LIMIT, so a large Duka history catalog
    # cannot hide an equally relevant OANDA candidate behind thousands of rows.
    ranked = select(candidates, func.row_number().over(partition_by=(candidates.c.match_rank, candidates.c.source),
        order_by=(candidates.c.symbol, candidates.c.dataset_id, candidates.c.mapping_id)).label("source_position")).subquery()
    candidates_query = select(ranked).order_by(ranked.c.match_rank, ranked.c.source_position, ranked.c.source,
        ranked.c.symbol, ranked.c.dataset_id, ranked.c.mapping_id).offset(offset).limit(501)
    records = list(db.execute(candidates_query).mappings())
    items, item_offsets, examined = [], [], 0
    for record in records[:500]:
        examined += 1
        try:
            ident = record["version_id"] if kind == "history" else definition(db, record["dataset_id"], record["mapping_id"])[-1]
            meta = _metadata(db, ident, kind, composite_context=(record["dataset_id"], record["mapping_id"],
                db.get(MarketComposite, ident)) if kind == "composite" else None)
        except ValueError:
            continue
        if calendar and meta["calendar"] != calendar:
            continue
        dataset = db.get(MarketDataset, record["dataset_id"])
        inst = db.get(Instrument, dataset.instrument_id)
        from .search_types import symbol_type as asset_type
        items.append({**meta, "type": asset_type(dataset.asset_class), "ticker": encode(ident, kind), "label": inst.label,
            "description": f"{'自建' if kind == 'history' else '组合'} · {dataset.identity['source']}"
                f"{'→OANDA Practice' if kind == 'composite' else ''} · {inst.basis} · {meta['calendar']}", "available": True})
        item_offsets.append(offset + examined)
        if len(items) == page_size:
            break
    has_more = examined < len(records)
    return {"items": items, "item_offsets": item_offsets, "offset": offset, "page_size": page_size, "examined": examined,
        "has_more": has_more, "next_offset": offset + examined if has_more else None}


def search(db, query="", *, kind="all", limit=100):
    """No registration, demand, supplier requests, or mutable-version fallback."""
    if kind not in ("all", "history", "composite") or not 1 <= limit <= 250:
        raise ValueError("无效行情搜索范围")
    if kind != "all":
        return search_page(db, query, kind=kind, page_size=limit)["items"]
    histories = search_page(db, query, kind="history", page_size=limit)["items"]
    composites = search_page(db, query, kind="composite", page_size=limit)["items"]
    return [row for pair in zip_longest(histories, composites) for row in pair if row][:limit]
