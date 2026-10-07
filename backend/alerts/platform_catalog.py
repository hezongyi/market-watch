"""Paged, read-only native instrument directory; never opens provider demand."""

from sqlalchemy import select

from .history_catalog import account_scope, asset_class
from .provider_dukascopy import catalog as dukascopy_catalog
from .source_registry import capabilities
from .storage import MarketCatalog


def catalog(db, *, query="", source=None, page=1, page_size=25):
    if page < 1 or not 1 <= page_size <= 100:
        raise ValueError("无效的目录分页")
    if source and source not in ("dukascopy", "oanda", "binance", "yahoo"):
        raise ValueError("未知平台来源")
    items = {}
    # Scoped account entries resolve through the explicit OANDA native ID.
    # Legacy entries retain their existing identity when they cover that symbol.
    for row in db.scalars(select(MarketCatalog).order_by(MarketCatalog.id.startswith("HC:"))):
        scoped = row.id.startswith("HC:")
        if source and row.source != source or row.source == "dukascopy":
            continue
        if scoped and (row.source != "oanda" or
                       (row.metadata_json or {}).get("history_account_scope") != account_scope()):
            continue
        key = (row.source, row.symbol)
        if key in items:
            continue
        items[key] = {"id": "OANDA:" + row.symbol if scoped else row.id,
            "source": row.source, "provider_symbol": row.symbol, "label": row.label,
            "asset_class": asset_class(row.asset_type, row.symbol), "precision": row.precision,
            "history_precision": row.precision, "precision_status": "source_catalog",
            "available": row.available, "updated_at": row.updated_at,
            "capabilities": capabilities(row.source)}
    if not source or source == "dukascopy":
        for row in dukascopy_catalog():
            items[("dukascopy", row["symbol"])] = {**row, "provider_symbol": row["symbol"],
                "history_precision": None, "updated_at": None,
                "capabilities": capabilities("dukascopy")}
    term = query[:100].strip().casefold()
    rows = sorted((row for row in items.values() if term in
        (row["provider_symbol"] + row["label"] +
         row.get("logical_symbol", "")).casefold()),
        key=lambda row: (row["provider_symbol"], row["source"], row["id"]))
    start = (page - 1) * page_size
    return {"items": rows[start:start + page_size], "total": len(rows),
            "page": page, "page_size": page_size}
