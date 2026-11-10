"""History source selection: SDK symbols and explicitly refreshed scoped metadata."""

import hashlib
import re
from datetime import UTC, datetime

from .config import settings


def account_scope():
    return "sha256:" + hashlib.sha256(settings.oanda_account_id.encode()).hexdigest()


def oanda_catalog_id(symbol):
    return "HC:" + hashlib.sha256((account_scope() + "|" + symbol).encode()).hexdigest()[:36]


def oanda_entry(db, symbol):
    from .storage import MarketCatalog

    return db.get(MarketCatalog, oanda_catalog_id(symbol))


def asset_class(kind, symbol):
    if symbol in ("XAU_USD", "XAG_USD", "XAU/USD", "XAG/USD") or "METAL" in kind:
        return "metal"
    if kind == "CURRENCY" or kind.startswith("INSTRUMENT_FX_"):
        return "forex"
    if kind in ("CRYPTO", "CRYPTOCURRENCY") or kind.startswith("INSTRUMENT_VCCY_"):
        return "crypto"
    if kind == "INDEX" or kind.startswith("INSTRUMENT_IDX_"):
        return "index"
    if kind in ("EQUITY", "STOCK"):
        return "equity"
    if kind in ("ETF", "FUND", "MUTUALFUND") or kind.startswith("INSTRUMENT_ETF_CFD_"):
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


def creation_entry(row):
    from .instrument_directory import logical_symbol
    from .market_presentation import source_name

    source, symbol, info = row["source"], row["symbol"], row["metadata_json"]
    verified = info.get("verified_frames" if source == "akshare" else "archive_verified_frames", {})
    family = "sina-a" if info.get("source_family") == "eastmoney-a" else info.get("source_family")
    result = {"source": source, "provider_symbol": symbol, "catalog_id": row["id"],
        "source_display": source_name(source, family=family, environment="practice" if source == "oanda" else "demo" if source == "fxcm" else "public"),
        "logical_symbol": logical_symbol(source, symbol), "label": row["label"],
        "display_symbol": row["display_symbol"], "asset_class": row["asset_class"],
        "precision": None if info.get("precision_status") == "manual_required" else row["precision"],
        "precision_status": info.get("precision_status", "source_catalog"),
        "availability": "catalog; periods_verified_on_demand", "updated_at": row["updated_at"] or None,
        "metadata_origin": info.get("directory_origin", info.get("metadata_origin", source + " local catalog"))}
    if source in ("akshare", "yahoo"):
        from .provider_akshare import supported_frames
        from .provider_capabilities import YAHOO_INTERVALS

        supported = supported_frames(symbol, "sina-a" if info.get("source_family") == "eastmoney-a" else info.get("source_family")) if source == "akshare" else list(YAHOO_INTERVALS)
        result.update({"supported_modes": ["base_d1", "native_periods"], "verified_frames": verified,
            "availability": "verified_periods" if any(verified.values()) else "probe_required",
            "supported_frames": {"none": supported},
            "default_mode": "base_d1" if row["asset_class"] in ("equity", "etf") else "native_periods",
            "aggregation_calendar": "source_date", "timezone": info.get("timezone"),
            "default_start_date": "2000-01-01"})
        if source == "akshare" and symbol.startswith("HKEX:"):
            evidence = info.get("probes", {}).get("none", {}).get("D1", {})
            observed_start = evidence.get("requested_start")
            result["default_start_date"] = (datetime.fromtimestamp(observed_start / 1000, UTC).date().isoformat()
                if evidence.get("status") == "verified" and type(observed_start) is int else None)
    return result


def catalog(db, *, source, query="", page=1, page_size=25, symbol_type=""):
    from .history_creation_check import search_catalog
    from .instrument_directory import SOURCES

    if source not in SOURCES or page < 1 or not 1 <= page_size <= 100:
        raise ValueError("无效的自建来源目录查询")
    result = search_catalog(db, source=source, query=query, symbol_type=symbol_type,
                            offset=(page - 1) * page_size, limit=page_size)
    status = result.pop("sources")[0]
    return {**result,
        "page": page, "page_size": page_size, "source": source,
        "requires_refresh": status["requires_refresh"],
        "coverage_policy": "actual confirmed observations determine availability"}


def validate_selection(db, *, catalog_id, source, provider_symbol, logical_symbol, asset_class, precision):
    from .instrument_directory import selected

    row = selected(db, source, catalog_id)
    item = creation_entry(row) if row else None
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
    from .catalog_sync import publish

    scope = account_scope()
    records = [{"id": oanda_catalog_id(item["name"]),
        "symbol": item["name"], "label": item.get("displayName", item["name"]),
        "asset_type": item.get("type", "UNKNOWN"), "precision": item["displayPrecision"],
        "calendar": "ny17", "metadata_json": {"history_account_scope": scope,
            "origin": "oanda_practice_account_catalog"}} for item in items]
    result = publish("oanda", records, scope=scope, complete=True,
        advertised_total=len(items), origin="OANDA Practice account instruments", mark_missing=True)
    return {**result, "updated_at": result["last_success"]}


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
    from .catalog_sync import publish

    records = [{"id": "FXCM:" + hashlib.sha256((scope + "|" + item["symbol"]).encode()).hexdigest()[:32],
        "symbol": item["symbol"], "label": item["symbol"], "precision": item["digits"],
        "asset_type": {1: "CURRENCY", 2: "INDEX", 5: "METAL", 6: "EQUITY"}.get(item["instrument_type"], "OTHER"),
        "calendar": None, "metadata_json": {"history_account_scope": scope,
            "origin": "fxcm_demo_forexconnect_offers", "instrument_type": item["instrument_type"],
            "native_frames": list(depths), "native_query_depths": depths}} for item in items]
    result = publish("fxcm", records, scope=scope, complete=True,
        advertised_total=len(items), origin="FXCM Demo ForexConnect Offers", mark_missing=True)
    return {**result, "updated_at": result["last_success"]}
