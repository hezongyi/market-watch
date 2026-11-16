"""Additive, read-only mobile labels over the actual series metadata."""

STOCK_MARKETS = {
    "SZSE": "深A", "SSE": "沪A", "BSE": "北A", "HKEX": "港股", "HKG": "港股", "HK": "港股",
    "NMS": "美股", "NYQ": "美股", "NCM": "美股", "NGM": "美股", "PCX": "美股",
    "ASE": "美股", "BTS": "美股", "NASDAQ": "美股", "NYSE": "美股", "US": "美股",
    "NYS": "美股", "NAS": "美股", "JP": "日股", "TSE": "日股", "JPX": "日股",
    "LSE": "英股", "UK": "英股", "GB": "英股", "XETRA": "德股", "GER": "德股", "DE": "德股",
}
SOURCE_FAMILIES = {"sina-a": "新浪财经", "sina-hk": "新浪财经", "sina-futures": "新浪财经",
                   "tencent-a": "腾讯财经", "tencent-hk": "腾讯财经", "eastmoney-a": "东方财富"}


def mobile_identity(meta, identity=None):
    saved = identity or meta.get("source_identity") or {}
    # Saved acquisition facts override catalog defaults, including unknown values.
    info = {**(meta.get("metadata_json") or {}), **meta, **(saved.get("parameters") or {}), **saved}
    source = info.get("source", "")
    family = info.get("source_family")
    symbol = info.get("provider_symbol") or info.get("symbol", "")
    kind = str(info.get("asset_type") or "").upper()
    asset = info.get("asset_class", "")
    from .history_catalog import asset_class
    if not asset and kind:
        asset = asset_class(kind, symbol)
    exchange = str(info.get("exchange_code") or info.get("exchange") or "").upper()
    if source == "akshare" and ":" in symbol:
        exchange = symbol.split(":", 1)[0]
    if source == "dukascopy" and asset == "equity" and "." in symbol and "/" in symbol:
        exchange = symbol.rsplit(".", 1)[1].split("/", 1)[0]
    product_type = str(info.get("product_type") or "").lower()
    product = ""
    if kind in ("FUND", "MUTUALFUND"):
        category = "基金"
    elif kind == "BOND":
        category = "债券"
    elif kind == "OPTION":
        category = "期权"
    elif kind == "COMMODITY":
        category = "商品"
    elif asset == "future" or kind in ("FUTURE", "FUTURES"):
        category = "期货"
        product = "主力连续" if family == "sina-futures" else str(info.get("contract_month") or "")
    elif asset == "etf" or kind == "ETF":
        category = "ETF"
    elif asset == "equity":
        category = STOCK_MARKETS.get(exchange, "股票")
    elif asset == "index":
        category = "股指" if info.get("index_type") == "stock" else "指数"
    else:
        category = {"forex": "外汇", "metal": "贵金属", "crypto": "加密", "commodity": "商品"}.get(asset, "待分类")
    if asset == "crypto":
        contract = str(info.get("contract_type") or "").upper()
        product = {"PERPETUAL": "永续", "SPOT": "现货", "DELIVERY": "交割"}.get(contract, "")
        if source == "binance" and not contract:
            product = "现货"  # This integration is Binance Spot only.
        if info.get("delivery_date"):
            product = str(info["delivery_date"]) + "交割"
    # The live Dukascopy directory normalizes asset_type to ETF but retains
    # the same ETF_CFD group recognized by history_catalog.product_metadata.
    etf_cfd = source == "dukascopy" and category == "ETF" and info.get("group") == "ETF_CFD"
    if kind == "CFD" or "cfd" in product_type or "_CFD_" in kind or etf_cfd:
        product = "CFD"
    if category == "期权":
        product = " ".join(str(info[k]) for k in ("expiry", "option_type", "strike") if info.get(k) is not None)
    provider = SOURCE_FAMILIES.get(family, "AKShare") if source == "akshare" else {
        "dukascopy": "Dukas", "yahoo": "Yahoo", "binance": "Binance", "oanda": "OANDA", "fxcm": "FXCM",
    }.get(source, source or "来源待确认")
    return {"category": category, "provider": provider, "channel": "AKShare" if source == "akshare" else "",
            "product": product, "environment": {"practice": "模拟", "demo": "模拟", "live": "实盘", "real": "实盘"}.get(info.get("environment"), ""),
            "provider_symbol": symbol}


def dataset_display_metadata(db, datasets):
    """One local metadata read per page; identities remain authoritative."""
    from sqlalchemy import select, tuple_

    from .storage import MarketCatalog
    pairs = {(d.identity["source"], d.identity["provider_symbol"]) for d in datasets}
    if not pairs:
        return {}
    candidates = list(db.scalars(select(MarketCatalog).where(tuple_(MarketCatalog.source, MarketCatalog.symbol).in_(pairs)).order_by(MarketCatalog.id)))
    output = {}
    keys = ("exchange", "exchange_code", "group", "product_type", "index_type", "contract_type", "contract_month", "delivery_date", "expiry", "option_type", "strike")
    for dataset in datasets:
        origin = dataset.identity
        for row in candidates:
            if (row.source, row.symbol) != (origin["source"], origin["provider_symbol"]):
                continue
            info = row.metadata_json or {}
            if info.get("history_account_scope") not in (None, origin.get("account_scope")):
                continue
            output[dataset.id] = {"asset_type": row.asset_type, **{key: info[key] for key in keys if key in info}}
            break
    return output
