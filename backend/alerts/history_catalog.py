"""History source selection: SDK symbols and explicitly refreshed scoped metadata."""

import hashlib
import re

from sqlalchemy import select

from .config import settings
from .market_names import display_code, matches_code
from .storage import MarketCatalog, now_ms, transaction


def account_scope():
    return "sha256:" + hashlib.sha256(settings.oanda_account_id.encode()).hexdigest()


def asset_class(kind, symbol):
    if symbol in ("XAU_USD", "XAG_USD", "XAU/USD", "XAG/USD") or "METAL" in kind:
        return "metal"
    if kind == "CURRENCY" or kind.startswith("INSTRUMENT_FX_"):
        return "forex"
    if kind.startswith("INSTRUMENT_VCCY_"):
        return "crypto"
    if kind == "INDEX" or kind.startswith("INSTRUMENT_IDX_"):
        return "index"
    return "other"


def catalog(db, *, source, query="", page=1, page_size=25):
    if source not in ("dukascopy", "oanda") or page < 1 or not 1 <= page_size <= 100:
        raise ValueError("无效的自建来源目录查询")
    requires_refresh = False
    if source == "dukascopy":
        from dukascopy_python import instruments

        items = []
        for name, symbol in vars(instruments).items():
            if not name.startswith("INSTRUMENT_") or not isinstance(symbol, str):
                continue
            logical = re.sub(r"[^A-Z0-9]", "", symbol.upper())
            if not 0 < len(logical) <= 10:
                continue
            if not matches_code(query, symbol, source, asset_class(name, symbol), logical):
                continue
            items.append({"source": source, "provider_symbol": symbol, "logical_symbol": logical,
                "catalog_id": "DK:" + hashlib.sha256(symbol.encode()).hexdigest()[:36],
                "label": symbol, "display_symbol": display_code(symbol, source, asset_class(name, symbol)),
                "asset_class": asset_class(name, symbol), "precision": None,
                "precision_status": "manual_required", "availability": "sdk_symbol; coverage_not_verified",
                "metadata_origin": "dukascopy-python instruments", "updated_at": None})
    else:
        scope = account_scope()
        rows = [row for row in db.scalars(select(MarketCatalog).where(MarketCatalog.source == source,
                MarketCatalog.available.is_(True)))
                if row.metadata_json.get("history_account_scope") == scope]
        requires_refresh = not rows
        items = [{"source": source, "provider_symbol": row.symbol,
            "catalog_id": row.id,
            "logical_symbol": re.sub(r"[^A-Z0-9]", "", row.symbol.upper()),
            "display_symbol": display_code(row.symbol, source, row.asset_type),
            "label": row.label, "asset_class": asset_class(row.asset_type, row.symbol),
            "precision": row.precision, "precision_status": "source_catalog",
            "availability": "account_catalog; coverage_not_verified", "updated_at": row.updated_at,
            "metadata_origin": "OANDA Practice account instruments"}
            for row in rows
            if matches_code(query, row.symbol, source, row.asset_type, row.label) and
            len(re.sub(r"[^A-Z0-9]", "", row.symbol)) <= 10]
    items.sort(key=lambda row: row["provider_symbol"])
    # Read-only lookup never refreshes, registers a dataset or opens streaming.
    start = (page - 1) * page_size
    return {"items": items[start:start + page_size], "total": len(items), "page": page,
            "page_size": page_size, "source": source,
            "requires_refresh": requires_refresh,
            "coverage_policy": "actual confirmed M1 observations determine availability"}


def validate_selection(db, *, catalog_id, source, provider_symbol, logical_symbol, asset_class, precision):
    matches = catalog(db, source=source, query=provider_symbol, page_size=100)["items"]
    item = next((row for row in matches if row["catalog_id"] == catalog_id), None)
    if not item or any(item[key] != value for key, value in (
            ("provider_symbol", provider_symbol), ("logical_symbol", logical_symbol), ("asset_class", asset_class))):
        raise ValueError("所选来源目录已变化或不属于当前账户，请重新选择或明确手工登记")
    if item["precision"] is not None and item["precision"] != precision:
        raise ValueError("价格精度与来源目录不一致，请重新选择")


def refresh_oanda():
    if not settings.oanda_token or not settings.oanda_account_id:
        raise ValueError("请先配置OANDA Practice连接")
    from .providers import fetch_oanda_catalog

    items = fetch_oanda_catalog()  # Network outside the database transaction.
    scope, stamp = account_scope(), now_ms()
    with transaction() as db:
        for row in db.scalars(select(MarketCatalog).where(MarketCatalog.source == "oanda")):
            if row.metadata_json.get("history_account_scope") == scope:
                row.available = False
        for item in items:
            symbol = item["name"]
            ident = "HC:" + hashlib.sha256((scope + "|" + symbol).encode()).hexdigest()[:36]
            row = db.get(MarketCatalog, ident)
            if row is None:
                row = MarketCatalog(id=ident, source="oanda", symbol=symbol)
                db.add(row)
            row.label, row.asset_type = item.get("displayName", symbol), item.get("type", "UNKNOWN")
            row.precision, row.updated_at, row.available = item["displayPrecision"], stamp, True
            row.calendar = "ny17" if asset_class(row.asset_type, symbol) in ("forex", "metal") else None
            row.metadata_json = {"history_account_scope": scope, "origin": "oanda_practice_account_catalog"}
    return {"source": "oanda", "count": len(items), "updated_at": stamp}
