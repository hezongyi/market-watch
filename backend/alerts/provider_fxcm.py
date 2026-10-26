"""Account-scoped FXCM native snapshots; no resampling or quote stream."""

import time

from fastapi import HTTPException
from sqlalchemy import select

from .fxcm_history import FRAMES, FxcmHistory, account_scope, configured
from .storage import MarketCatalog, now_ms, transaction

CALENDAR = "fxcm_native"
COMPLETION = "elapsed_native_interval; confirmation_not_supplied"
_ADAPTER = FxcmHistory()  # Construction performs no I/O; native idle timeout logs out.


def close_session():
    _ADAPTER.close()


def metadata(ident):
    if not configured():
        raise HTTPException(422, "FXCM历史连接未启用或未配置")
    scope = account_scope()
    with transaction() as db:
        row = db.get(MarketCatalog, ident)
        if (row is None or row.source != "fxcm" or not row.available
                or row.metadata_json.get("history_account_scope") != scope):
            raise HTTPException(404, "未知当前账户FXCM品种，请显式刷新目录")
        return {"id": row.id, "symbol": row.symbol, "name": row.label,
            "source": "fxcm", "basis": "bid", "series_kind": "provider",
            "account_scope": scope, "precision": row.precision,
            "frames": row.metadata_json.get("native_frames", ["M1", "H1", "D1"]),
            "native_query_depths": row.metadata_json.get("native_query_depths", {}), "calendar": CALENDAR,
            "calendar_version": "fxcm-native-unverified-v1",
            "timezone": "Etc/UTC", "session": "24x7",
            "session_verified": False, "native_page_capacity": 300,
            "volume_kind": "tick_count", "volume_unit": "price_changes",
            "completion_basis": COMPLETION,
            "native_month_assembly": "same_month_previous_close_chain_v1; raw fragments retained",
            "price_description": "Bid · FXCM原生周期 · 交易时段未核实",
            "request_parameters": {"price": "BID", "candle_open": "PreviousClose"},
            "source_identity": {"source": "fxcm", "channel": "forexconnect",
                "environment": "demo", "account_scope": scope,
                "provider_symbol": row.symbol, "basis": "bid",
                "parameters": {"price": "BID", "candle_open": "PreviousClose"}}}


def symbol_metadata(symbol):
    scope = account_scope()
    with transaction() as db:
        ident = next((row.id for row in db.scalars(select(MarketCatalog).where(
            MarketCatalog.source == "fxcm", MarketCatalog.symbol == symbol,
            MarketCatalog.available.is_(True)))
            if row.metadata_json.get("history_account_scope") == scope), None)
    if ident is None:
        raise ValueError("FXCM当前账户目录中无此品种，请显式刷新目录")
    return metadata(ident)


def native_page(meta, frame, before, count, *, client=None, deadline=None, optional=0):
    if frame not in FRAMES or frame not in meta["frames"] or not 1 <= count <= 300 or optional < 0:
        raise ValueError("无效FXCM原生周期或条数")
    if not configured() or meta["account_scope"] != account_scope():
        raise ValueError("FXCM当前账户与平台缓存身份不一致")
    requested = min(meta.get("native_query_depths", {}).get(frame, 300), count + optional)
    deadline = deadline or time.monotonic() + 65
    adapter = client or _ADAPTER
    # Reuse the active demand session for consecutive pages; never prewarm it.
    raw = adapter.bars(meta["symbol"], frame, 0, before, meta["precision"],
                       count=requested, deadline=deadline, scope=meta["account_scope"])
    observed, rows = now_ms(), []
    for index, row in enumerate(raw):
        start = row["start"]
        widths = {"M1": 60000, "M5": 300000, "M15": 900000, "M30": 1800000,
                  "H1": 3600000, "H4": 14400000}
        if frame in widths:
            end = start + widths[frame]
        else:
            # Preserve native day/week/month timestamps, including DST. A next
            # observed start is authoritative; otherwise use an elapsed upper
            # bound, without claiming supplier confirmation.
            bound = {"D1": 25, "W1": 7 * 24 + 1, "MN": 31 * 24 + 1}[frame] * 3600000
            following = raw[index + 1]["start"] if index + 1 < len(raw) else None
            end = following if following is not None and following - start <= bound else start + bound
        closed = end <= observed
        rows.append({**row, "end": end, "chart_time": start,
            "complete": closed, "time_closed": closed,
            "volume_complete": closed, "source_confirmed": None,
            "completion_basis": COMPLETION})
    return {"bars": rows, "has_more": True, "history_boundary": False,
        "coverage": [[rows[0]["start"], before]] if rows else [],
        "boundary_evidence": None, "series_kind": "provider",
        "basis": "bid", "calendar": CALENDAR, "precision": meta["precision"],
        "source": "fxcm", "symbol": meta["symbol"], "indicators": [],
        "volume_kind": "tick_count", "volume_unit": "price_changes",
        "completion_basis": COMPLETION, "session_verified": False, "as_of": observed,
        "request_evidence": {"requested": requested, "returned": len(raw),
            "before_exclusive": before, "price": "BID",
            "candle_open": "PreviousClose", "include_weekends": False}}
