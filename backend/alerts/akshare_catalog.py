"""Local-first directory and symbol-specific verified native capabilities."""

import hashlib

from .config import settings
from .market_contracts import HISTORY_FRAMES, DatasetIdentity
from .provider_akshare import AKShareHistory, collection_identity, endpoint, invoke, symbol_rules
from .source_history_store import _insert
from .storage import MarketCatalog, now_ms, transaction

# Development probes recorded under docs/verification/history-modes-20261024.
# These are observations, never a promise of supplier retention or all symbols.
VERIFIED = {
    "SZSE:000001": {"none": ["D1"]},
    "HKEX:00700": {"none": []},
    "SHFE:RB0": {"none": ["M5", "D1"]},
}
SEEDS = {"SZSE:000001": "平安银行", "HKEX:00700": "腾讯控股", "SHFE:RB0": "螺纹钢主力连续"}


def stable_id(symbol):
    symbol_rules(symbol)
    return "AKSHARE:" + hashlib.sha256(symbol.encode()).hexdigest()[:32]


def logical_symbol(symbol):
    info = symbol_rules(symbol)
    prefix = {"SZSE": "SZ", "SSE": "SH", "BSE": "BJ", "HKEX": "HK", "SHFE": "SF",
              "DCE": "DC", "CZCE": "CZ", "CFFEX": "CF", "INE": "IN", "GFEX": "GF"}[info["exchange"]]
    return prefix + info["code"]


def details(symbol, verified=None):
    info = symbol_rules(symbol)
    if info["source_family"] == "eastmoney-a" and info["exchange"] != "BSE":
        info = symbol_rules(symbol, "sina-a")
    frames = (verified or {}).get("none", [])
    return {**info, "symbol": symbol, "frames": [frame for frame in HISTORY_FRAMES if frame in frames],
        "verified_frames": verified or {}, "adjustment": "none", "volume_kind": "quantity",
        "precision": 5 if info["source_family"] == "sina-hk" else 4,
        "asset_class": "future" if info["source_family"] == "sina-futures" else "equity",
        "window_basis": "observed response only; history continuity is not guaranteed"}


def seed():
    if not settings.akshare_enabled:
        return
    with transaction() as db:
        for symbol, label in SEEDS.items():
            data = details(symbol, VERIFIED[symbol])
            db.execute(_insert(db)(MarketCatalog).values(id=stable_id(symbol), source="akshare",
                symbol=symbol, label=label, asset_type="FUTURE" if data["asset_class"] == "future" else "EQUITY",
                precision=data["precision"], calendar="source_date", available=True,
                metadata_json=data, updated_at=0).on_conflict_do_nothing(index_elements=["id"]))


def get_details(db, symbol):
    from .provider_akshare import catalog_allowed
    if not catalog_allowed(symbol):
        raise ValueError("新建仅支持既有新浪/腾讯股票及新浪主力连续目录")
    row = db.get(MarketCatalog, stable_id(symbol))
    if not row or not row.available or row.source != "akshare":
        raise ValueError("请先从 AKShare 品种目录选择有效代码")
    if row.asset_type not in ("EQUITY", "STOCK", "FUTURE", "FUTURES"):
        raise ValueError("新建仅支持股票及新浪主力连续期货")
    info = dict(row.metadata_json)
    if info.get("source_family") == "eastmoney-a" and not symbol.startswith("BSE:"):
        info = {**info, **symbol_rules(symbol, "sina-a")}
    return info, row


def probe(symbol, frames, *, adjustment="none", start=1262304000000):
    """Explicit user-selected symbol/period probes, never a background scan."""
    if not settings.akshare_enabled:
        raise ValueError("AKShare 行情源未启用")
    if not frames or len(frames) > 9 or any(frame not in HISTORY_FRAMES for frame in frames):
        raise ValueError("请选择项目白名单内的周期")
    with transaction() as db:
        info, _ = get_details(db, symbol)
    identity = DatasetIdentity(source="akshare", channel="python", environment="public",
        account_scope="public", provider_symbol=symbol, basis="last", calendar_version="akshare-source-date-v1",
        identity_version=2, mode="base_d1" if adjustment != "none" else "native_periods",
        base_frame="D1" if adjustment != "none" else None, source_family=info["source_family"],
        adjustment=adjustment, trading_date_rule=info["trading_date_rule"])
    from .provider_akshare import supported_frames

    allowed = supported_frames(symbol, identity.source_family, adjustment)
    results = {}
    for frame in frames:
        if frame not in allowed:
            results[frame] = {"status": "unsupported", "reason": "既有接口没有此原生周期"}
            continue
        try:
            source = collection_identity(identity, frame)
            batch = AKShareHistory().native_page(source, start, now_ms())
            valid = [row for row in batch.rows if row.complete]
            results[frame] = {"status": "verified" if valid else "unavailable",
                "endpoint": endpoint(symbol, frame, adjustment, identity.source_family), "observed_at": batch.observed_at,
                "rows": len(valid), "first": valid[0].start if valid else None,
                "last": valid[-1].end if valid else None, "requested_start": start}
        except Exception:
            results[frame] = {"status": "error", "reason": "本次请求失败，保留已验证周期，可稍后重试"}
    with transaction() as db:
        info, row = get_details(db, symbol)
        verified = {key: list(value) for key, value in info.get("verified_frames", {}).items()}
        current = set(verified.get(adjustment, [])) - {frame for frame, result in results.items() if result["status"] != "error"}
        current.update(frame for frame, result in results.items() if result["status"] == "verified")
        verified[adjustment] = [frame for frame in HISTORY_FRAMES if frame in current]
        row.metadata_json = {**info, **details(symbol, verified), "probes": {**info.get("probes", {}), adjustment: results}}
        row.updated_at = now_ms()
    return {"source": "akshare", "provider_symbol": symbol, "adjustment": adjustment,
            "frames": verified[adjustment], "results": results}


def refresh(market):
    """Catalog only: no candle requests and no maintenance registration."""
    if not settings.akshare_enabled:
        raise ValueError("AKShare 行情源未启用")
    endpoints = {"a": "stock_info_a_code_name", "hk": "stock_hk_spot", "futures": "futures_display_main_sina"}
    if market not in endpoints:
        raise ValueError("请选择 a、hk 或 futures 市场")
    records = invoke(endpoints[market], {})
    from .catalog_sync import publish

    items = []
    for record in records:
        code = str(record.get("code") or record.get("代码") or record.get("symbol") or "")
        label = record.get("name") or record.get("名称") or record.get("中文名称") or code
        if not code:
            continue
        if market == "a":
            if not code.startswith(("6", "0", "3")):
                continue  # The existing Sina/Tencent paths cover Shanghai/Shenzhen only.
            exchange = "SSE" if code.startswith("6") else "SZSE"
        elif market == "hk":
            exchange, code = "HKEX", code.zfill(5)
        else:
            exchange = {"shfe": "SHFE", "dce": "DCE", "czce": "CZCE",
                "cffex": "CFFEX", "ine": "INE", "gfex": "GFEX"}.get(record.get("exchange", "").lower())
            if not exchange or not code.endswith("0"):
                continue
        symbol = exchange + ":" + code.upper()
        from .provider_akshare import catalog_allowed

        if not catalog_allowed(symbol):
            continue
        info = details(symbol)
        items.append({"id": stable_id(symbol), "symbol": symbol, "label": label,
            "asset_type": "FUTURE" if market == "futures" else "EQUITY",
            "precision": info["precision"], "calendar": "source_date",
            "metadata_json": {key: value for key, value in info.items()
                if key not in ("verified_frames", "frames")}})
    result = publish("akshare", items, partition=market, complete=True,
        origin=endpoints[market], mark_missing=True)
    return {**result, "market": market}



def chart_metadata(ident):
    from .provider_akshare import supported_frames

    if not settings.akshare_enabled:
        raise ValueError("AKShare 行情源未启用")
    tencent = ident.startswith("TENCENT:")
    symbol = ident.removeprefix("TENCENT:") if tencent else None
    with transaction() as db:
        row = db.get(MarketCatalog, stable_id(symbol)) if tencent else db.get(MarketCatalog, ident)
        if not row or row.source != "akshare" or not row.available:
            raise ValueError("未知 AKShare 品种，请刷新目录")
        info = dict(row.metadata_json)
        if tencent:
            if not row.symbol.startswith(("SSE:", "SZSE:")):
                raise ValueError("腾讯平台接口当前仅支持沪深 A 股")
            info.update(symbol_rules(row.symbol, "tencent-a"))
        elif info["source_family"] == "eastmoney-a":
            info.update(symbol_rules(row.symbol, "sina-a"))
        return {**info, "id": ident if tencent else row.id,
            "name": row.label, "name_zh": info.get("name_zh"), "symbol": row.symbol,
            "display_symbol": row.symbol, "source": "akshare", "basis": "last",
            "calendar": "source_date", "series_kind": "provider", "series_kinds": ["provider"],
            "frames": ["D1"] if info["source_family"] in ("sina-a", "sina-hk", "tencent-a") else supported_frames(row.symbol, info["source_family"]),
            "adjustment": "qfq" if info["source_family"] in ("sina-a", "sina-hk", "tencent-a") else "none",
            "price_description": ("腾讯前复权" if tencent else "新浪前复权")
                if info["source_family"] in ("sina-a", "sina-hk", "tencent-a") else "AKShare 原生价格",
            "volume_kind": "quantity", "asset_type": "FUTURE" if info["source_family"] == "sina-futures" else "EQUITY",
            # These are source-date candles; the acquisition session identity
            # is not a TradingView session expression or verified intraday calendar.
            "session": "24x7", "session_verified": False,
            "volume_unit": info.get("volume_unit"), "stream": False}
