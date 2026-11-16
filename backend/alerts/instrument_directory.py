"""Local instrument search shared by platform and managed selection.

Provider calls belong to catalog synchronization, never to this module. SQL
qualifies, deduplicates and pages persistent rows before decoding metadata.
"""

import hashlib
import re

from sqlalchemy import JSON, Text, and_, case, func, literal, literal_column, or_, select, union_all

from .history_catalog import account_scope, asset_class
from .market_names import alias_search, chinese_name, code_search, display_code, matches_code
from .storage import Instrument, MarketCatalog, MarketDataset

SOURCES = ("dukascopy", "oanda", "binance", "yahoo", "akshare", "fxcm")
ASSETS = ("forex", "metal", "crypto", "index", "equity", "etf", "future", "other")


def logical_symbol(source, symbol):
    """Retain existing short aliases; never truncate an exact supplier code."""
    if source in ("yahoo", "akshare"):
        from .history_mode_sources import logical_symbol as existing

        return existing(source, symbol)
    compact = re.sub(r"[^A-Z0-9]", "", symbol.upper())
    return compact if 0 < len(compact) <= 10 else (
        source[0].upper() + hashlib.sha256(symbol.encode()).hexdigest()[:9].upper())


def _asset(kind, symbol):
    return case(
        (or_(kind == "METAL", symbol.in_(("XAU_USD", "XAG_USD", "XAU/USD", "XAG/USD"))), "metal"),
        (or_(kind.in_(("CURRENCY", "FOREX")), kind.startswith("INSTRUMENT_FX_", autoescape=True)), "forex"),
        (or_(kind.in_(("CRYPTO", "CRYPTOCURRENCY")), kind.startswith("INSTRUMENT_VCCY_", autoescape=True)), "crypto"),
        (or_(kind == "INDEX", kind.startswith("INSTRUMENT_IDX_", autoescape=True)), "index"),
        (kind.in_(("EQUITY", "STOCK")), "equity"),
        (or_(kind.in_(("ETF", "FUND", "MUTUALFUND")), kind.startswith("INSTRUMENT_ETF_CFD_", autoescape=True)), "etf"),
        (kind.in_(("FUTURE", "FUTURES")), "future"),
        else_="other")


def _search_text(columns):
    # One literal substring search over the same fields, matching the PG index.
    fields = (columns.symbol, columns.label, *(
        columns.metadata_json.op("->>", return_type=Text)(literal_column("'" + key + "'"))
        for key in ("name_zh", "exchange", "english_name")),
        columns.source, columns.asset_type)
    value = func.coalesce(fields[0], "")
    for field in fields[1:]:
        value = value + literal(" ") + func.coalesce(field, "")
    return value


def _variant(ident):
    """Platform source/price variants share a physical catalog, not an identity."""
    return case((ident.startswith("TENCENT:"), 1),
                (ident.startswith("SINA-NATIVE:"), 2),
                (ident.startswith("TENCENT-NATIVE:"), 3), else_=0)


def _statement(db, *, source=None, managed=False, query="", asset=None, mobile=False, exclude_watch=False, exclude_existing=False, retain_watch=()):
    from .config import settings
    from .fxcm_history import account_scope as fxcm_scope
    from .fxcm_history import configured
    from .provider_akshare import CATALOG_PATTERN

    c = MarketCatalog
    scope = c.metadata_json["history_account_scope"].as_string()
    visible = or_(~c.id.startswith("HC:"), (c.source == "oanda") & (scope == account_scope()))
    visible &= or_(c.source != "oanda", scope.is_(None), scope == account_scope())
    visible &= or_(c.source != "fxcm", scope == (fxcm_scope() if configured() else "disabled"))
    visible &= or_(c.source != "fxcm", c.available.is_(True))
    # User-selected Yahoo scope excludes mainland and Hong Kong equities.
    visible &= or_(c.source != "yahoo", and_(*(
        ~func.upper(c.symbol).like("%." + suffix) for suffix in ("HK", "SS", "SZ", "BJ"))))
    visible &= or_(c.source != "akshare", and_(c.symbol.regexp_match(CATALOG_PATTERN),
        or_(and_(c.asset_type.in_(("EQUITY", "STOCK")),
                or_(*(c.symbol.startswith(prefix) for prefix in ("SSE:", "SZSE:", "HKEX:")))),
            and_(c.asset_type.in_(("FUTURE", "FUTURES")), ~c.symbol.startswith("HKEX:")))))
    if managed:
        visible &= c.available.is_(True)
        visible &= or_(c.source != "oanda", c.id.startswith("HC:"))
        visible &= or_(~c.source.in_(("oanda", "fxcm")),
                       scope == case((c.source == "oanda", account_scope()),
                                     else_=fxcm_scope() if configured() else "disabled"))
        if not settings.yahoo_enabled:
            visible &= c.source != "yahoo"
        if not settings.akshare_enabled:
            visible &= c.source != "akshare"
    if source:
        visible &= c.source == source
    if mobile:
        from .mobile_symbol_search import predicate, tokens
        # Match descriptive/long terms before short provider-like substrings.
        # Separate materialized stages prevent PG reordering a broad short token
        # ahead of the selective term. Every term retains cross-field OR.
        terms = sorted(tokens(query), key=lambda term: (any("\u4e00" <= ch <= "\u9fff" for ch in term), len(term)), reverse=True)
        for index, term in enumerate(terms or [""]):
            visible &= predicate(term, c.source, c.symbol, _asset(c.asset_type, c.symbol),
                indexed_text=_search_text(c), exchange=func.coalesce(c.metadata_json["exchange_code"].as_string(),
                    c.metadata_json["exchange"].as_string()), family=case((c.metadata_json["source_family"].as_string() == "eastmoney-a", "sina-a"), else_=c.metadata_json["source_family"].as_string()),
                variants=not managed, kind=c.asset_type, product=c.metadata_json["contract_type"].as_string(),
                adjustment=c.metadata_json["adjustment"].as_string(), basis=c.metadata_json["basis"].as_string(),
                index_type=c.metadata_json["index_type"].as_string())
            c = select(c).where(visible).cte(f"mobile_catalog_{index}").prefix_with("MATERIALIZED", dialect="postgresql").c
            visible = literal(True)
    extra_terms = []
    if mobile and not managed:
        from .mobile_symbol_search import series_terms
        extra_terms = series_terms(query)
        if extra_terms:
            # Let the directory index find generic matches once per term. A
            # supplier-only search must not normalize labels across every
            # physical row and its four expanded source/price variants.
            c = select(c, *(c.id.in_(select(MarketCatalog.id).where(predicate(
                term, MarketCatalog.source, MarketCatalog.symbol,
                _asset(MarketCatalog.asset_type, MarketCatalog.symbol),
                indexed_text=_search_text(MarketCatalog))).correlate(None)).label(f"series_match_{index}")
                for index, term in enumerate(extra_terms))).cte("mobile_series_matches").prefix_with("MATERIALIZED", dialect="postgresql").c
    columns = (c.id, c.source, c.symbol, c.label, c.asset_type, c.precision,
               c.calendar, c.updated_at, c.available, c.metadata_json, c.id.label("physical_id"),
               *(c[f"series_match_{index}"] for index in range(len(extra_terms))))
    branches = [select(*columns, literal(0).label("priority")).where(visible)]
    if not managed and source in (None, "akshare"):
        for prefix, exchanges in (("TENCENT:", ("SSE:", "SZSE:")),
                                  ("SINA-NATIVE:", ("SSE:", "SZSE:")),
                                  ("TENCENT-NATIVE:", ("SSE:", "SZSE:", "HKEX:"))):
            branches.append(select((literal(prefix) + c.symbol).label("id"),
                *columns[1:], literal(0).label("priority")).where(visible, c.source == "akshare",
                    or_(*(c.symbol.startswith(exchange) for exchange in exchanges))))
    if not managed and source in (None, "oanda", "binance"):
        i = Instrument
        branches.append(select(i.id, i.source, i.symbol, i.label,
            case((i.source == "binance", "CRYPTO"), else_="CURRENCY").label("asset_type"),
            i.precision, i.calendar, literal(0).label("updated_at"),
            literal(True).label("available"), literal({}, type_=JSON).label("metadata_json"), i.id.label("physical_id"),
            *(predicate(term, i.source, i.symbol, literal(""), i.label) for term in extra_terms),
            literal(2).label("priority")).where(
                i.source.in_((source,) if source else ("oanda", "binance")),
                i.id.not_in(select(MarketDataset.instrument_id)),
                predicate(query, i.source, i.symbol,
                    _asset(case((i.source == "binance", "CRYPTO"), else_="CURRENCY"), i.symbol),
                    i.label, basis=i.basis, product=literal("SPOT") if source == "binance" else None) if mobile else literal(True)))
    candidates = union_all(*branches).subquery()
    filtered = select(candidates)
    if mobile and not managed:
        # Source variants must be qualified before pagination, after expansion.
        family = case((candidates.c.id.startswith("TENCENT:"), "tencent-a"),
                      (candidates.c.id.startswith("TENCENT-NATIVE:"), "tencent-a"),
                      (candidates.c.id.startswith("SINA-NATIVE:"), "sina-a"),
                      (candidates.c.metadata_json["source_family"].as_string() == "eastmoney-a", "sina-a"),
                      else_=candidates.c.metadata_json["source_family"].as_string())
        adjustment = case((_variant(candidates.c.id).in_((2, 3)), "none"),
                          (and_(candidates.c.source == "akshare", family.in_(("sina-a", "sina-hk", "tencent-a"))), "qfq"),
                          else_=candidates.c.metadata_json["adjustment"].as_string())
        for index, term in enumerate(extra_terms):
            filtered = filtered.where(or_(candidates.c[f"series_match_{index}"],
                predicate(term, candidates.c.source, literal(""), literal(""), family=family, adjustment=adjustment)))
    if not mobile and query.strip():
        filtered = filtered.where(or_(alias_search(query, candidates.c.source, candidates.c.symbol),
            code_search(query, _search_text(candidates.c))))
    if exclude_watch:
        from .mobile_symbol_search import watched
        excluded = watched(db, retain_watch)["provider"]
        filtered = filtered.where(candidates.c.id.not_in(excluded),
            ~and_(candidates.c.source == "oanda", (literal("OANDA:") + candidates.c.symbol).in_(excluded)),
            ~and_(candidates.c.source == "binance", candidates.c.symbol.in_(excluded)))
    if exclude_existing:
        # Exact product/account, regardless of mode/calendar or archive status.
        from .storage import DatasetMaintenance, RealtimeMapping
        owned = select(MarketDataset.id).outerjoin(DatasetMaintenance).where(
            MarketDataset.identity["source"].as_string() == candidates.c.source,
            MarketDataset.identity["provider_symbol"].as_string() == candidates.c.symbol,
            or_(DatasetMaintenance.dataset_id.is_not(None), select(RealtimeMapping.id).where(
                RealtimeMapping.dataset_id == MarketDataset.id).exists()))
        # Account-scoped catalogs have already been qualified above; only the
        # current account's identities exclude a current account product.
        account = candidates.c.metadata_json["history_account_scope"].as_string()
        owned = owned.where(or_(account.is_(None), MarketDataset.identity["account_scope"].as_string() == account))
        filtered = filtered.where(~owned.exists())
    if asset:
        filtered = filtered.where(_asset(candidates.c.asset_type, candidates.c.symbol) == asset)
    qualified = filtered.subquery()
    numbered = select(qualified.c.id, qualified.c.source, qualified.c.symbol, qualified.c.physical_id,
        func.row_number().over(
        partition_by=(qualified.c.source, qualified.c.symbol, _variant(qualified.c.id)),
        order_by=(qualified.c.priority, qualified.c.id.startswith("HC:"), qualified.c.id)
    ).label("position")).subquery()
    return select(numbered).where(numbered.c.position == 1), numbered


def _hydrate(db, records):
    """Read metadata only for the chosen page, after identity ordering."""
    records = [dict(row) for row in records]
    ids = {row["physical_id"] for row in records}
    catalogs = {row.id: row for row in db.scalars(select(MarketCatalog).where(MarketCatalog.id.in_(ids)))} if ids else {}
    legacy_ids = ids - catalogs.keys()
    legacy = {row.id: row for row in db.scalars(select(Instrument).where(Instrument.id.in_(legacy_ids)))} if legacy_ids else {}
    result = []
    for value in records:
        row = catalogs.get(value["physical_id"])
        if row is not None:
            details = {key: getattr(row, key) for key in ("label", "asset_type", "precision", "calendar",
                "updated_at", "available", "metadata_json")}
        else:
            row = legacy[value["physical_id"]]
            details = {"label": row.label, "asset_type": "CRYPTO" if row.source == "binance" else "CURRENCY",
                "precision": row.precision, "calendar": row.calendar, "updated_at": 0,
                "available": True, "metadata_json": {}}
        result.append(_present({**value, **details}))
    return result


def _present(row):
    item = dict(row)
    item.pop("position", None)
    item.pop("priority", None)
    info = item["metadata_json"] or {}
    item["supplier_name"] = item["label"]
    item["name_zh"] = info.get("name_zh") or chinese_name(item["source"], item["symbol"]) or ""
    item["label"] = item["name_zh"] or item["label"]
    item["asset_class"] = asset_class(item["asset_type"], item["symbol"])
    if item["asset_type"] in ("CRYPTOCURRENCY", "MUTUALFUND"):
        item["asset_class"] = "crypto" if item["asset_type"] == "CRYPTOCURRENCY" else "etf"
    item["provider_symbol"] = item["symbol"]
    item["display_symbol"] = display_code(item["symbol"], item["source"], item["asset_type"])
    item["logical_symbol"] = logical_symbol(item["source"], item["symbol"])
    return item


def search(db, *, query="", source=None, asset=None, managed=False, offset=0, limit=25, include_total=True, mobile=False, exclude_watch=False, exclude_existing=False, retain_watch=()):
    if source not in (None, *SOURCES) or asset not in (None, *ASSETS) or offset < 0 or limit < 1:
        raise ValueError("无效品种目录查询")
    statement, rows = _statement(db, source=source, managed=managed, query=query, asset=asset, mobile=mobile, exclude_watch=exclude_watch, exclude_existing=exclude_existing, retain_watch=retain_watch)
    # Counting identities does not need window ordering or supplier metadata.
    if include_total:
        variant = _variant(rows.c.id)
        identities = select(rows.c.source, rows.c.symbol, variant).group_by(
            rows.c.source, rows.c.symbol, variant).subquery()
        total = db.scalar(select(func.count()).select_from(identities))
    # Until the first runtime sync, keep the pinned SDK directory discoverable.
    # It is explicitly marked unverified and never performs network I/O.
    fallback = []
    from .mobile_symbol_search import watched
    watched_provider_ids = watched(db, retain_watch)["provider"] if exclude_watch else set()
    if source in (None, "dukascopy") and not db.scalar(select(MarketCatalog.id).where(
            MarketCatalog.source == "dukascopy").limit(1)):
        from .provider_dukascopy import catalog

        existing = set()
        if exclude_existing:
            from .storage import DatasetMaintenance
            existing = set(db.scalars(select(MarketDataset.identity["provider_symbol"].as_string()).join(DatasetMaintenance)
                .where(MarketDataset.identity["source"].as_string() == "dukascopy")))
        for row in catalog():
            if row["symbol"] in existing:
                continue
            if exclude_watch and row["id"] in watched_provider_ids:
                continue
            if mobile:
                from .mobile_symbol_search import matches
                if asset and row["asset_class"] != asset or not matches(query, {**row, "source": "dukascopy"}):
                    continue
            elif asset and row["asset_class"] != asset or not matches_code(query,
                    row["symbol"], "dukascopy", row["asset_type"], row["label"], chinese_name("dukascopy", row["symbol"]) or ""):
                continue
            fallback.append(_present({"id": row["id"], "source": "dukascopy", "symbol": row["symbol"],
                "label": row["label"], "asset_type": row["asset_type"], "precision": 8,
                "calendar": None, "updated_at": 0, "available": True,
                "metadata_json": {"metadata_origin": row["metadata_origin"],
                                  "precision_status": "manual_required"}}))
    term = query.strip().upper()
    compact_term = re.sub(r"[/_-]", "", term)
    compact_symbol = func.replace(func.replace(func.replace(func.upper(rows.c.symbol), "_", ""), "/", ""), "-", "")
    rank = case((or_(func.upper(rows.c.symbol) == term, compact_symbol == compact_term), 0),
        (or_(func.upper(rows.c.symbol).startswith(term, autoescape=True),
             compact_symbol.startswith(compact_term, autoescape=True)), 1), else_=2) if term else literal(0)
    statement = statement.order_by(rank, rows.c.symbol, rows.c.source, rows.c.id)
    fetch_limit = limit if include_total else limit + 1
    if fallback:
        fetched = _hydrate(db, db.execute(statement.limit(offset + fetch_limit)).mappings())
        def order(row):
            symbol = row["symbol"].upper()
            compact = re.sub(r"[/_-]", "", symbol)
            rank = 0 if term and (symbol == term or compact == compact_term) else (
                1 if term and (symbol.startswith(term) or compact.startswith(compact_term)) else 2)
            return rank, row["symbol"], row["source"], row["id"]
        items = sorted(fetched + fallback, key=order)
        return {"items": items[offset:offset + limit], **(
            {"total": total + len(fallback)} if include_total else {"has_more": len(items) > offset + limit})}
    records = list(db.execute(statement.offset(offset).limit(fetch_limit)).mappings())
    return {"items": _hydrate(db, records[:limit]), **(
        {"total": total} if include_total else {"has_more": len(records) > limit})}


def has_entries(db, source):
    if source == "dukascopy":
        return True  # The pinned offline directory remains discoverable before sync.
    statement, rows = _statement(db, source=source, managed=True)
    return db.scalar(statement.with_only_columns(rows.c.id).limit(1)) is not None


def selected(db, source, ident):
    """Resolve one selected identity through the same scope filters, without text paging."""
    statement, rows = _statement(db, source=source, managed=True)
    value = db.execute(statement.where(rows.c.id == ident)).mappings().first()
    if value:
        return _hydrate(db, [value])[0]
    if source == "dukascopy":
        # The bounded SDK fallback has no persistent rows before its first sync.
        return next((row for row in search(db, source=source, managed=True, limit=10000)["items"]
            if row["id"] == ident), None)
    return None
