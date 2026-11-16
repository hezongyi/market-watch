"""Mobile-only literal token matching and stable watch identities.

Searches remain local, and all qualification happens before pagination.
"""

import re

from sqlalchemy import and_, false, func, literal, or_, select

from .market_names import alias_search, code_search, matches_code, pair_query
from .storage import AdvancedPreference, HistoryVersion, Instrument, MarketComposite, MarketDataset

PROVIDERS = {"oanda": "OANDA Practice", "dukascopy": "Dukascopy Dukas",
    "yahoo": "Yahoo Finance", "binance": "Binance 币安", "akshare": "AKShare", "fxcm": "FXCM Demo"}
CATEGORIES = {"forex": "外汇 货币 forex currency", "metal": "金属 贵金属 metal commodity",
    "crypto": "加密 数字货币 cryptocurrency crypto", "equity": "股票 stock equity",
    "etf": "基金 ETF fund", "index": "指数 index", "future": "期货 futures future", "other": "其他 other"}


def tokens(query):
    return query[:100].strip().casefold().split()


PRICE_ALIASES = {"none": "不复权", "qfq": "前复权", "hfq": "后复权", "auto": "来源复权"}

UPSTREAMS = {"sina-": "新浪 新浪财经 sina", "tencent-": "腾讯 腾讯财经 tencent", "eastmoney-a": "东方财富 eastmoney"}


def upstream_terms(query):
    return [term for term in tokens(query) if any(term in label.casefold() for label in UPSTREAMS.values())]


def series_terms(query):
    return [term for term in tokens(query) if term in upstream_terms(query) or any(term in label for label in PRICE_ALIASES.values())]


def predicate(query, source, symbol, asset, *labels, exchange=None, indexed_text=None, family=None, variants=False, kind=None, product=None, adjustment=None, basis=None, index_type=None):
    # Fold fixed vocabulary in Python instead of running CASE/string transforms
    # for every catalog row. A term still matches ANY field, never a forced source.
    compact = func.replace(func.replace(func.replace(symbol, "_", ""), "/", ""), "-", "")
    us_market = or_(symbol.endswith(".US/USD", autoescape=True), and_(source == "yahoo",
        (exchange if exchange is not None else literal("")).in_(("NMS", "NYQ", "NCM", "NGM", "PCX", "ASE", "BTS", "NASDAQ", "NYSE", "US", "NYS", "NAS"))))
    conditions = []
    for term in tokens(query):
        providers = [key for key, value in PROVIDERS.items() if term in value.casefold()]
        categories = [key for key, value in CATEGORIES.items() if term in value.casefold()]
        if indexed_text is not None:
            # The normalized directory index is a superset for compact SYMBOL
            # matching. Recheck the symbol to avoid inventing compact-name matches.
            def contains(column, value):
                pattern = "%" + value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
                return column.like(pattern, escape="\\") if value.upper() == value.lower() else column.ilike(pattern, escape="\\")
            compact_text = func.replace(func.replace(func.replace(indexed_text, "_", ""), "/", ""), "-", "")
            # Trigrams cannot accelerate one/two-character tokens. Avoid
            # normalizing the entire long metadata text for every short match.
            text_match = or_(contains(indexed_text, term), contains(compact, term)) if len(term) < 3 else or_(
                contains(indexed_text, term), and_(contains(compact_text, term), contains(compact, term)))
            pair = pair_query(term)
            if pair:
                text_match = or_(text_match, contains(compact_text, pair))
        else:
            text_match = code_search(term, symbol, compact, source, *labels)
        fields = [text_match, alias_search(term, source, symbol, compact=True)]
        prices = [key for key, label in PRICE_ALIASES.items() if term in label]
        if prices:
            fields.append(and_(source == "akshare", literal(True)) if variants else adjustment.in_(prices) if adjustment is not None else false())
        if basis is not None and term in ("bid", "ask", "mid", "买价", "卖价", "中间价"):
            fields.append(basis == {"买价": "bid", "卖价": "ask", "中间价": "mid"}.get(term, term))
        if index_type is not None and term in "股指 股票指数":
            fields.append(and_(asset == "index", index_type == "stock"))
        upstream = [key for key, label in UPSTREAMS.items() if term in label.casefold()]
        if upstream:
            exact = or_(*(family.startswith(key, autoescape=True) if key.endswith("-") else family == key for key in upstream)) if family is not None else false()
            fields.append(and_(source == "akshare", literal(True) if variants else exact))
        if kind is not None:
            if term in ("基金", "fund"):
                fields.append(kind.in_(("ETF", "FUND", "MUTUALFUND")))
            elif term == "etf":
                fields.append(kind == "ETF")
            for code, names in (("BOND", "债券 bond"), ("OPTION", "期权 option")):
                if term in names:
                    fields.append(kind == code)
        if product is not None:
            for code, names in (("PERPETUAL", "永续 perpetual"), ("SPOT", "现货 spot"), ("DELIVERY", "交割 delivery")):
                if term in names:
                    fields.append(or_(product == code, and_(source == "binance", asset == "crypto") if code == "SPOT" else false()))
        if term in "主力连续":
            fields.append(and_(source == "akshare", asset == "future"))
        for name, prefix in (("沪A 沪市", "SSE:"), ("深A 深市", "SZSE:"), ("港股", "HKEX:")):
            if term in name:
                fields.append(and_(asset == "equity", symbol.startswith(prefix)))
        if providers:
            fields.append(source.in_(providers))
        if categories:
            if term == "etf" and kind is not None:
                categories = [value for value in categories if value != "etf"]
            fields.append(asset.in_(categories))
        if term in "美股 美国股票 us stocks":
            fields.append(and_(asset.in_(("equity", "etf")), us_market))
        conditions.append(or_(*fields))
    return and_(*conditions) if conditions else ~false()


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


def watched(db, retain=()):
    # A search drawer may retain its own successful additions until it closes.
    # Resolve the same stable identities used by write-time deduplication.
    values = set(identities(db, watch_symbols(db)).values())
    if retain:
        values -= set(identities(db, retain).values())
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
