"""Atomic directory snapshots and local refresh state, without history demand."""

from sqlalchemy import select

from .market_names import chinese_name
from .storage import MarketCatalog, Preference, now_ms, transaction

ASSET_LABELS = {"CURRENCY": "外汇", "METAL": "贵金属", "CRYPTO": "加密资产",
    "CRYPTOCURRENCY": "加密资产", "INDEX": "指数", "EQUITY": "股票", "STOCK": "股票",
    "ETF": "交易型基金", "FUND": "基金", "MUTUALFUND": "共同基金",
    "FUTURE": "期货", "FUTURES": "期货", "BOND": "债券", "OPTION": "期权"}


def _key(source, scope, partition):
    return f"instrument-directory:{source}:{scope}:{partition}"


def localized(source, symbol, label, kind, info):
    """Reliable names first; unknown foreign names keep their original text."""
    if info.get("name_zh_origin") == "manual":
        return info["name_zh"], "manual"
    if any("\u4e00" <= char <= "\u9fff" for char in label):
        return label, "supplier"
    known = chinese_name(source, symbol)
    if known:
        return known, "mapping"
    category = ASSET_LABELS.get(kind, "金融品种")
    market = info.get("exchange") or info.get("exchange_code") or source
    return f"{label} · {market} {category}", "description"



def belongs_to_partition(row, scope, partition):
    info = row.metadata_json or {}
    if info.get("directory_partition"):
        return (info.get("directory_scope"), info["directory_partition"]) == (scope, partition)
    # Upgrade existing catalog rows without rewriting their source/history identities.
    if row.source in ("oanda", "fxcm"):
        return partition == "all" and info.get("history_account_scope") == scope
    if row.source == "akshare":
        market = "a" if row.symbol.startswith(("SSE:", "SZSE:")) else "hk" if row.symbol.startswith("HKEX:") else "futures"
        return scope == "public" and market == partition
    return row.source in ("dukascopy", "binance") and scope == "public" and partition == "all"

def publish(source, records, *, scope="public", partition="all", complete=False,
            advertised_total=None, origin="", mark_missing=False):
    """Fetch every page before calling; a failed partition never deletes rows.

    Completeness describes the declared source partition, not a provider's
    global universe. Metadata/history observations and manual names survive.
    """
    records = list(records)
    if not records or len({item["symbol"] for item in records}) != len(records):
        raise ValueError("目录为空或包含重复品种，保留最近成功目录")
    if complete and advertised_total is not None and len(records) != advertised_total:
        raise ValueError("目录数量与供应商总数不符，保留最近成功目录")
    stamp = now_ms()
    with transaction() as db:
        ids = {item["id"] for item in records}
        old_rows = list(db.scalars(select(MarketCatalog).where(MarketCatalog.source == source).with_for_update()))
        previous = {row.id: row for row in old_rows}
        for item in records:
            row = previous.get(item["id"])
            if row is not None and (row.source != source or row.symbol != item["symbol"]):
                raise ValueError("目录身份冲突")
            if row is None:
                row = MarketCatalog(id=item["id"], source=source, symbol=item["symbol"])
                db.add(row)
            info = {**(row.metadata_json or {}), **item.get("metadata_json", {})}
            if (row.metadata_json or {}).get("name_zh_origin") == "manual":
                info.update({key: row.metadata_json[key] for key in ("name_zh", "name_zh_origin")})
            label = item.get("label") or item["symbol"]
            kind = item.get("asset_type", "OTHER")
            name, name_origin = localized(source, item["symbol"], label, kind, info)
            row.label, row.asset_type = label[:200], kind
            row.precision = item.get("precision", row.precision if row.precision is not None else 8)
            row.calendar = item.get("calendar", row.calendar)
            row.available, row.updated_at = item.get("available", True), stamp
            row.metadata_json = {**info, "name_zh": name[:200], "name_zh_origin": name_origin,
                "directory_scope": scope, "directory_partition": partition,
                "directory_origin": origin, "directory_complete": complete}
        if complete and mark_missing:
            for row in old_rows:
                info = row.metadata_json or {}
                if belongs_to_partition(row, scope, partition) and row.id not in ids:
                    row.available = False
        key = _key(source, scope, partition)
        status = db.get(Preference, key)
        if status is None:
            status = Preference(key=key, value={})
            db.add(status)
        status.value = {"source": source, "scope": scope, "partition": partition,
            "status": "complete" if complete else "partial", "count": len(records),
            "advertised_total": advertised_total, "last_success": stamp,
            "last_attempt": stamp, "origin": origin}
    return status.value


def describe(db, ident, name):
    if not name.strip() or len(name) > 200:
        raise ValueError("中文描述须为1至200个字符")
    row = db.scalar(select(MarketCatalog).where(MarketCatalog.id == ident).with_for_update())
    if row is None:
        raise ValueError("目录品种不存在，请先更新供应商目录")
    row.metadata_json = {**row.metadata_json, "name_zh": name.strip(), "name_zh_origin": "manual"}
    return {"id": row.id, "name_zh": name.strip(), "name_zh_origin": "manual"}


def statuses(db, source=None):
    statement = select(Preference).where(Preference.key.startswith("instrument-directory:"))
    return [row.value for row in db.scalars(statement.order_by(Preference.key))
            if not source or row.value.get("source") == source]


def refresh_dukascopy():
    import httpx

    from .config import settings
    from .provider_dukascopy import stable_id

    url = "https://jetta.dukascopy.com/v1/instruments"
    with httpx.Client(timeout=30, proxy=settings.market_proxy or None, trust_env=False) as client:
        response = client.get(url, headers={"Origin": "https://widgets.dukascopy.com",
            "Referer": "https://widgets.dukascopy.com/", "Accept": "application/json,text/plain,*/*",
            "User-Agent": "Mozilla/5.0"})
        response.raise_for_status()
        payload = response.json()
    groups = {group["id"]: group for group in payload["groups"]}
    roots = {"FX": "CURRENCY", "CMD": "COMMODITY", "IDX": "INDEX",
             "BND_CFD": "BOND", "STCK_CFD": "EQUITY", "ETF_CFD": "ETF", "VCCY": "CRYPTO"}
    records = []
    for item in payload["instruments"]:
        # The official list includes cash/crypto/fund rows with groupId=null.
        # Keep their exact identity even when the supplier has no category.
        group = groups.get(item["groupId"], {})
        while group.get("parentId") in groups:
            group = groups[group["parentId"]]
        kind = roots.get(group.get("code"), "OTHER")
        kind = {"CRYPTO_DC": "CRYPTO", "CRYPTO_CURR": "CRYPTO",
                "MUTUAL_FUNDS": "FUND"}.get(item.get("platformGroupId"), kind)
        symbol = item["name"]
        if symbol in ("XAU/USD", "XAG/USD", "XPT/USD", "XPD/USD"):
            kind = "METAL"
        precision = item["priceScale"]
        if precision is not None and (type(precision) is not int or not 0 <= precision <= 10):
            raise ValueError("来源目录精度无效")
        records.append({"id": stable_id(symbol), "symbol": symbol,
            "label": item.get("description") or symbol, "asset_type": kind,
            "precision": precision if precision is not None else 8, "calendar": None,
            "metadata_json": {"provider_code": item["code"], "group": group.get("code"),
                "exchange": item.get("countryCode"), "platform_group": item.get("platformGroupId"),
                "precision_status": "source_catalog" if precision is not None else "manual_required", "native_frames": [
                    "M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN"]}})
    return publish("dukascopy", records, complete=True, advertised_total=len(payload["instruments"]),
                   origin=url, mark_missing=True)


def refresh_binance():
    import time
    from decimal import Decimal

    from .provider_transport import binance_get, pooled_client

    url = "https://data-api.binance.vision/api/v3/exchangeInfo"
    response = binance_get(pooled_client("binance"), url,
        params={"showPermissionSets": "false"}, deadline=time.monotonic() + 30)
    items = response.json()["symbols"]
    records = []
    for item in items:
        tick = next(entry["tickSize"] for entry in item["filters"] if entry["filterType"] == "PRICE_FILTER")
        precision = max(0, -Decimal(tick).normalize().as_tuple().exponent)
        records.append({"id": "BINANCE:" + item["symbol"], "symbol": item["symbol"],
            "label": item["baseAsset"] + " / " + item["quoteAsset"], "asset_type": "CRYPTO",
            "precision": precision, "calendar": "utc0",
            "metadata_json": {"exchange": "Binance Spot", "base_asset": item["baseAsset"],
                "quote_asset": item["quoteAsset"], "trading_status": item["status"],
                "spot_trading_allowed": item.get("isSpotTradingAllowed", False), "tick_size": tick}})
    return publish("binance", records, complete=True, advertised_total=len(items),
                   origin=url, mark_missing=True)


def failed(source, *, scope="public", partition="all", reason="来源目录刷新失败"):
    """Record failure separately from the last successfully published snapshot."""
    with transaction() as db:
        key = _key(source, scope, partition)
        row = db.get(Preference, key)
        if row is None:
            row = Preference(key=key, value={"source": source, "scope": scope, "partition": partition})
            db.add(row)
        row.value = {**row.value, "status": "failed", "last_attempt": now_ms(), "error": reason}
        return row.value


def refresh(source, *, market="a"):
    """One refresh entry for HTTP and runtime; failed attempts keep old rows."""
    from . import akshare_catalog, history_catalog, yahoo_catalog

    jobs = {"dukascopy": refresh_dukascopy, "binance": refresh_binance,
        "oanda": history_catalog.refresh_oanda, "fxcm": history_catalog.refresh_fxcm,
        "akshare": lambda: akshare_catalog.refresh(market), "yahoo": yahoo_catalog.refresh}
    if source not in jobs:
        raise ValueError("未知目录来源")
    scope = history_catalog.account_scope() if source == "oanda" else "public"
    if source == "fxcm":
        from .fxcm_history import account_scope
        scope = account_scope()
    partition = market if source == "akshare" else "all"
    try:
        return jobs[source]()
    except Exception:
        failed(source, scope=scope, partition=partition)
        raise
