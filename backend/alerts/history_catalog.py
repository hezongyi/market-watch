"""History source selection: SDK symbols and explicitly refreshed scoped metadata."""

import hashlib
import re
from datetime import UTC, datetime

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
    if kind in ("EQUITY", "STOCK"):
        return "equity"
    if kind in ("ETF", "FUND") or kind.startswith("INSTRUMENT_ETF_CFD_"):
        return "etf"
    if kind in ("FUTURE", "FUTURES"):
        return "future"
    # SDK stock entries use geographic groups, unlike FX/IDX/CMD families.
    # Match those groups and the exchange suffix together, never arbitrary
    # symbols (e.g. Yahoo XAAPL=F) or ETFs sharing the same exchange.
    stock_groups = ("US", "UK", "JAPAN", "HONG_KONG", "AUSTRIA", "BELGIUM",
        "DENMARK", "FINLAND", "FRANCE", "GERMANY", "IRELAND", "ITALY", "MEXICO",
        "NETHERLANDS", "NORWAY", "PORTUGAL", "SPAIN", "SWEDEN", "SWITZERLAND")
    if kind.startswith(tuple("INSTRUMENT_" + group + "_" for group in stock_groups)) and re.fullmatch(
            r"[A-Z0-9_-]+\.[A-Z]{2}/[A-Z]{3}", symbol):
        return "equity"
    return "other"


def product_metadata(kind, asset):
    if asset == "etf" and kind.startswith("INSTRUMENT_ETF_CFD_"):
        return {"product_type": "etf_cfd", "product_label": "ETF CFD"}
    if asset == "equity":
        # SDK grouping proves the underlying stock category, not ownership of
        # shares or a reviewed broker contract. Keep that distinction explicit.
        return {"product_type": "stock_source", "product_label": "股票类来源行情（具体合约类型待核实）"}
    return {}


def catalog(db, *, source, query="", page=1, page_size=25, symbol_type=""):
    from .search_types import TYPES
    from .search_types import symbol_type as search_type
    if symbol_type not in TYPES or source not in ("dukascopy", "oanda", "yahoo", "akshare", "fxcm") or page < 1 or not 1 <= page_size <= 100:
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
            items[-1].update(product_metadata(name, items[-1]["asset_class"]))
    elif source in ("oanda", "fxcm"):
        from .fxcm_history import account_scope as fxcm_scope
        from .fxcm_history import configured
        scope = fxcm_scope() if source == "fxcm" and configured() else "disabled" if source == "fxcm" else account_scope()
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
            "metadata_origin": "FXCM Demo ForexConnect Offers" if source == "fxcm" else "OANDA Practice account instruments"}
            for row in rows
            if matches_code(query, row.symbol, source, row.asset_type, row.label) and
            len(re.sub(r"[^A-Z0-9]", "", row.symbol)) <= 10]
    else:
        from .history_mode_sources import logical_symbol

        enabled = settings.akshare_enabled if source == "akshare" else settings.yahoo_enabled
        rows = list(db.scalars(select(MarketCatalog).where(MarketCatalog.source == source,
            MarketCatalog.available.is_(True)))) if enabled else []
        requires_refresh = not rows
        items = []
        for row in rows:
            if not matches_code(query, row.symbol, source, row.asset_type, row.label):
                continue
            info = row.metadata_json
            verified = info.get("verified_frames" if source == "akshare" else "archive_verified_frames", {})
            default_start = "2000-01-01"
            if source == "akshare" and row.symbol.startswith("HKEX:"):
                evidence = info.get("probes", {}).get("none", {}).get("D1", {})
                observed_start = evidence.get("requested_start")
                default_start = (datetime.fromtimestamp(observed_start / 1000, UTC).date().isoformat()
                    if evidence.get("status") == "verified" and type(observed_start) is int else None)
            items.append({"source": source, "provider_symbol": row.symbol, "catalog_id": row.id,
                "logical_symbol": logical_symbol(source, row.symbol), "label": row.label,
                "display_symbol": row.symbol, "asset_class": asset_class(row.asset_type, row.symbol),
                "precision": row.precision, "precision_status": "source_catalog",
                "availability": "verified_periods" if any(verified.values()) else "probe_required",
                "updated_at": row.updated_at, "metadata_origin": source + " local catalog",
                "supported_modes": ["base_d1", "native_periods"], "verified_frames": verified,
                "default_mode": "base_d1" if row.asset_type in ("EQUITY", "ETF") else "native_periods",
                "aggregation_calendar": "source_date", "timezone": info.get("timezone"),
                "default_start_date": default_start})
    if symbol_type:
        items = [row for row in items if search_type(row["asset_class"]) == symbol_type]
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


def refresh_fxcm():
    from .fxcm_history import FxcmHistory, configured
    from .fxcm_history import account_scope as fxcm_scope

    if not configured():
        raise ValueError("请先启用并配置FXCM历史连接")
    scope = fxcm_scope()
    adapter = FxcmHistory()
    try:
        items = adapter.catalog()  # All network I/O before the transaction.
        depths = adapter.timeframes()
        if not depths:
            raise ValueError("FXCM未提供系统支持的原生周期")
    finally:
        adapter.close()
    stamp = now_ms()
    with transaction() as db:
        for row in db.scalars(select(MarketCatalog).where(MarketCatalog.source == "fxcm")):
            if row.metadata_json.get("history_account_scope") == scope:
                row.available = False
        for item in items:
            symbol = item["symbol"]
            ident = "FXCM:" + hashlib.sha256((scope + "|" + symbol).encode()).hexdigest()[:32]
            row = db.get(MarketCatalog, ident)
            if row is None:
                row = MarketCatalog(id=ident, source="fxcm", symbol=symbol)
                db.add(row)
            row.label, row.precision = symbol, item["digits"]
            # Official O2GInstrumentType: Forex=1, Index=2, Commodity=3,
            # Treasury=4, Bullion=5, Shares=6, FXIndex=7, CFD=8.
            row.asset_type = {1: "CURRENCY", 2: "INDEX", 5: "METAL", 6: "EQUITY"}.get(item["instrument_type"], "OTHER")
            row.updated_at, row.available, row.calendar = stamp, True, None
            row.metadata_json = {"history_account_scope": scope,
                "origin": "fxcm_demo_forexconnect_offers", "instrument_type": item["instrument_type"],
                "native_frames": list(depths), "native_query_depths": depths}
    return {"source": "fxcm", "count": len(items), "updated_at": stamp}
