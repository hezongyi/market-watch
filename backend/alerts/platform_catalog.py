"""Paged, read-only native instrument directory; never opens provider demand."""

from sqlalchemy import select

from .config import settings
from .history_catalog import account_scope, asset_class
from .history_mode_sources import logical_symbol
from .market_names import display_code, matches_code
from .provider_dukascopy import catalog as dukascopy_catalog
from .source_registry import capabilities
from .storage import Instrument, MarketCatalog, MarketDataset


def entries(db, *, query="", source=None, asset=None):
    if asset not in (None,"forex","metal","crypto","index","equity","etf","future","other"):
        raise ValueError("未知资产类别")
    if source and source not in ("dukascopy", "oanda", "binance", "yahoo", "akshare", "fxcm"):
        raise ValueError("未知平台来源")
    items = {}
    fxcm_scope_value = None
    if source in (None, "fxcm"):
        from .fxcm_history import account_scope as fxcm_scope
        from .fxcm_history import configured
        if configured():
            fxcm_scope_value = fxcm_scope()
    statement = select(MarketCatalog).order_by(MarketCatalog.id.startswith("HC:"))
    if source:
        statement = statement.where(MarketCatalog.source == source)
    # Scoped account entries resolve through the explicit OANDA native ID.
    # Legacy entries retain their existing identity when they cover that symbol.
    for row in db.scalars(statement):
        scoped = row.id.startswith("HC:")
        if source and row.source != source or row.source == "dukascopy":
            continue
        if scoped and (row.source != "oanda" or
                       (row.metadata_json or {}).get("history_account_scope") != account_scope()):
            continue
        if row.source == "fxcm":
            if not row.available or fxcm_scope_value is None or row.metadata_json.get("history_account_scope") != fxcm_scope_value:
                continue
        key = (row.source, row.symbol)
        if key in items:
            continue
        items[key] = {"id": "OANDA:" + row.symbol if scoped else row.id,
            "source": row.source, "provider_symbol": row.symbol, "label": row.label, "asset_type": row.asset_type,
            **({"provider_name": "新浪 (AKShare)"} if row.source == "akshare" and
               row.metadata_json.get("source_family") in ("eastmoney-a", "sina-a", "sina-hk", "sina-futures") else {}),
            "asset_class": {"EQUITY":"equity","STOCK":"equity","ETF":"etf","FUND":"etf","FUTURE":"future","FUTURES":"future","CRYPTO":"crypto"}.get(row.asset_type,asset_class(row.asset_type, row.symbol)), "precision": row.precision,
            "history_precision": row.precision, "precision_status": "source_catalog",
            "available": row.available and (row.source != "yahoo" or settings.yahoo_enabled)
                and (row.source != "akshare" or settings.akshare_enabled),
            "updated_at": row.updated_at or None,
            "capabilities": {**capabilities(row.source), **({"native_periods": row.metadata_json.get("verified_frames", {}).get("none", [])} if row.source == "akshare" else {"native_periods": row.metadata_json.get("native_frames", ["M1", "H1", "D1"])} if row.source == "fxcm" else {})},
            "history_catalog_id": row.id,
            "verified_frames": row.metadata_json.get("verified_frames", row.metadata_json.get("archive_verified_frames", {})),
            "logical_symbol": (None if row.source not in ("akshare", "yahoo") else
                logical_symbol(row.source, row.symbol))}
        if row.source == "akshare" and row.symbol.startswith(("SSE:", "SZSE:", "HKEX:")):
            items[key]["capabilities"] = {**items[key]["capabilities"], "native_periods": ["D1"]}
        if row.source == "akshare" and row.symbol.startswith(("SSE:", "SZSE:")):
            tencent_id = "TENCENT:" + row.symbol
            items[("akshare-tencent", row.symbol)] = {**items[key], "id": tencent_id,
                "label": row.label + " · 腾讯", "provider_name": "腾讯 (AKShare)",
                "logical_symbol": None,
                "capabilities": {**items[key]["capabilities"], "native_periods": ["D1"],
                    "supported_modes": []}}
    # Bootstrap/legacy native identities live in instruments, before a source
    # catalog refresh. Retain those IDs so listing and chart resolution agree.
    for row in db.scalars(select(Instrument).where(Instrument.source.in_(("oanda", "binance") if not source else (source,) if source in ("oanda", "binance") else ()),
            Instrument.id.not_in(select(MarketDataset.instrument_id)))):
        if source and row.source != source:
            continue
        items.setdefault((row.source, row.symbol), {"id": row.id,
            "source": row.source, "provider_symbol": row.symbol, "label": row.label,
            "asset_class": "crypto" if row.source == "binance" else asset_class("CURRENCY", row.symbol),
            "precision": row.precision, "history_precision": row.precision,
            "precision_status": "registered_instrument", "available": True, "updated_at": None,
            "capabilities": capabilities(row.source)})
    if not source or source == "dukascopy":
        for row in dukascopy_catalog():
            items[("dukascopy", row["symbol"])] = {**row, "provider_symbol": row["symbol"],
                "history_precision": None, "updated_at": None,
                "capabilities": capabilities("dukascopy")}
    for row in items.values():
        row["display_symbol"] = display_code(row["provider_symbol"], row["source"], row.get("asset_type", row.get("asset_class")))
    rows = sorted((row for row in items.values() if matches_code(query, row["provider_symbol"],
        row["source"], row.get("asset_type", row.get("asset_class")), row["label"], row.get("logical_symbol") or "") and (not asset or row["asset_class"] == asset)),
        key=lambda row: (row["provider_symbol"], row["source"], row["id"]))
    return rows


def catalog(db, *, query="", source=None, page=1, page_size=25, asset=None):
    if page < 1 or not 1 <= page_size <= 100:
        raise ValueError("无效的目录分页")
    rows = entries(db, query=query, source=source, asset=asset)
    start = (page - 1) * page_size
    return {"items": rows[start:start + page_size], "total": len(rows),
            "page": page, "page_size": page_size}
