"""Mobile-only literal token matching and stable watch identities.

Searches remain local, and all qualification happens before pagination.
"""

import re

from sqlalchemy import and_, case, false, func, literal, or_, select

from .market_names import alias_search, code_search, matches_code
from .storage import AdvancedPreference, HistoryVersion, Instrument, MarketComposite, MarketDataset

PROVIDERS = {"oanda": "OANDA Practice", "dukascopy": "Dukascopy Dukas",
    "yahoo": "Yahoo Finance", "binance": "Binance 币安", "akshare": "AKShare", "fxcm": "FXCM Demo"}
CATEGORIES = {"forex": "外汇 货币 forex currency", "metal": "金属 贵金属 metal commodity",
    "crypto": "加密 数字货币 cryptocurrency crypto", "equity": "股票 stock equity",
    "etf": "基金 ETF fund", "index": "指数 index", "future": "期货 futures future", "other": "其他 other"}


def tokens(query):
    return query[:100].strip().casefold().split()


def predicate(query, source, symbol, asset, *labels, exchange=None):
    provider = case(PROVIDERS, value=source, else_=source)
    category = case(CATEGORIES, value=asset, else_=asset)
    compact = func.replace(func.replace(func.replace(symbol, "_", ""), "/", ""), "-", "")
    us_market = or_(symbol.endswith(".US/USD", autoescape=True), and_(source == "yahoo",
        (exchange if exchange is not None else literal("")).in_(("NMS", "NYQ", "NCM", "NGM", "PCX", "ASE", "BTS", "NASDAQ", "NYSE", "US", "NYS", "NAS"))))
    market = case((and_(asset.in_(("equity", "etf")), us_market), "美股 美国股票 US stocks"), else_="")
    return and_(*(or_(code_search(term, symbol, compact, source, provider, category, market, *labels),
        alias_search(term, source, symbol, compact=True)) for term in tokens(query))) if tokens(query) else ~false()


def matches(query, row):
    labels = [row.get("label", ""), row.get("name_zh", ""), PROVIDERS.get(row["source"], row["source"]),
        CATEGORIES.get(row.get("asset_class"), "")]
    if row.get("asset_class") in ("equity", "etf") and row["symbol"].endswith(".US/USD"):
        labels.append("美股 美国股票 US stocks")
    from .market_names import chinese_name
    labels.append(re.sub(r"[\s/_-]", "", chinese_name(row["source"], row["symbol"]) or ""))
    return all(matches_code(term, row["symbol"], row["source"], row.get("asset_type"), *labels)
        for term in tokens(query))


def watch_symbols(db):
    row = db.scalar(select(AdvancedPreference).where(AdvancedPreference.kind == "setting",
        AdvancedPreference.name == "mw.watchlists.v1", AdvancedPreference.tool == ""))
    return [ticker for group in (row.content.get("value", {}).get("lists", []) if row else [])
        for ticker in group.get("symbols", [])]


def identities(db, tickers):
    from .chart_series import decode
    decoded = {}
    for ticker in tickers:
        try:
            decoded[ticker] = decode(ticker)
        except ValueError:
            continue
    provider_ids = [ident for ident, kind in decoded.values() if kind == "provider"]
    # OANDA legacy aliases and the explicit provider code are the same default
    # feed. Native parameter variants keep their own immutable NATIVE identity.
    from .storage import MarketCatalog
    aliases = {}
    for table in (MarketCatalog, Instrument):
        for ident, source, symbol in db.execute(select(table.id, table.source, table.symbol).where(
                table.id.in_(provider_ids), table.source.in_(("oanda", "binance")))):
            aliases[ident] = "OANDA:" + symbol if source == "oanda" else symbol
    history = [ident for ident, kind in decoded.values() if kind == "history"]
    composite = [ident for ident, kind in decoded.values() if kind == "composite"]
    managed = [ident for ident, kind in decoded.values() if kind == "managed"]
    versions = dict(db.execute(select(HistoryVersion.id, HistoryVersion.dataset_id).where(HistoryVersion.id.in_(history))).all())
    composites = dict(db.execute(select(MarketComposite.id, MarketComposite.dataset_id).where(MarketComposite.id.in_(composite))).all())
    datasets = dict(db.execute(select(MarketDataset.instrument_id, MarketDataset.id).where(MarketDataset.instrument_id.in_(managed))).all())
    return {ticker: ("provider", aliases.get(ident, ident)) if kind == "provider" else
        ("dataset", versions.get(ident, ident)) if kind == "history" else
        ("dataset", composites.get(ident, ident)) if kind == "composite" else
        ("dataset", datasets.get(ident, ident)) for ticker, (ident, kind) in decoded.items()}


def watched(db):
    values = identities(db, watch_symbols(db)).values()
    return {kind: {ident for category, ident in values if category == kind} for kind in ("provider", "dataset")}


def validate_additions(db, old, new):
    """Keep old multi-group membership, reject newly introduced duplicate identities."""
    previous = {(group.get("id"), ticker) for group in old.get("value", {}).get("lists", []) for ticker in group.get("symbols", [])}
    memberships = [(group.get("id"), ticker) for group in new.get("value", {}).get("lists", []) for ticker in group.get("symbols", [])]
    resolved = identities(db, [ticker for _, ticker in [*previous, *memberships]])
    previous_counts = {}
    for _, ticker in previous:
        key = resolved.get(ticker, ("unknown", ticker))
        previous_counts[key] = previous_counts.get(key, 0) + 1
    counts = {}
    for _, ticker in memberships:
        key = resolved.get(ticker, ("unknown", ticker))
        counts[key] = counts.get(key, 0) + 1
    for membership in memberships:
        key = resolved.get(membership[1], ("unknown", membership[1]))
        if membership not in previous and counts[key] > max(1, previous_counts.get(key, 0)):
            raise ValueError("该品种已在自选中，请使用管理移动分组")


def existing_product(db, identity):
    from .storage import DatasetMaintenance, RealtimeMapping
    return db.scalar(select(MarketDataset).outerjoin(DatasetMaintenance).where(
        MarketDataset.identity["source"].as_string() == identity.source,
        MarketDataset.identity["provider_symbol"].as_string() == identity.provider_symbol,
        MarketDataset.identity["account_scope"].as_string() == identity.account_scope,
        MarketDataset.identity["environment"].as_string() == identity.environment,
        or_(DatasetMaintenance.dataset_id.is_not(None), select(RealtimeMapping.id).where(
            RealtimeMapping.dataset_id == MarketDataset.id).exists())).order_by(MarketDataset.id).limit(1))
