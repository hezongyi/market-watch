"""Local verified acquisition rules for D1 and native managed registration."""

import hashlib
import re

from .config import settings
from .market_contracts import HISTORY_FRAMES, DatasetIdentity, SourceIdentity
from .storage import MarketCatalog, now_ms, transaction


def dataset_identity(source, symbol, mode, adjustment):
    if mode not in ("base_d1", "native_periods") or source not in ("akshare", "yahoo"):
        raise ValueError("该来源尚未验证此历史维护模式")
    if source == "akshare":
        from .provider_akshare import symbol_rules

        info = symbol_rules(symbol)
        family, rule = info["source_family"], info["trading_date_rule"]
        if adjustment not in ("none", "qfq", "hfq"):
            raise ValueError("AKShare 不支持此价格口径")
    else:
        if not re.fullmatch(r"[A-Z0-9^=._-]{1,64}", symbol):
            raise ValueError("请选择准确的 Yahoo 品种代码")
        family, rule = "yfinance", "yahoo-exchange-date-v1"
        if adjustment not in ("none", "supplier"):
            raise ValueError("Yahoo 固定归档请选择不额外复权或供应商价格")
    return DatasetIdentity(source=source, channel="python" if source == "akshare" else "yfinance",
        environment="public", account_scope="public", provider_symbol=symbol, basis="last",
        calendar_version=source + "-source-date-v1", identity_version=2, mode=mode,
        base_frame="D1" if mode == "base_d1" else None, source_family=family,
        adjustment=adjustment, trading_date_rule=rule)


def local_details(db, source, symbol):
    if source == "akshare":
        from .akshare_catalog import get_details

        if not settings.akshare_enabled:
            raise ValueError("AKShare 行情源未启用")
        return get_details(db, symbol)
    from .provider_yahoo import stable_id

    if source != "yahoo" or not settings.yahoo_enabled:
        raise ValueError("Yahoo 行情源未启用")
    row = db.get(MarketCatalog, stable_id(symbol))
    info = dict(row.metadata_json) if row and row.available else {}
    if not info.get("timezone") or not info.get("session"):
        raise ValueError("请先加载 Yahoo 品种元信息并验证归档周期")
    quantity = info.get("volume_kind") in ("shares", "contracts")
    return {**info, "volume_kind": "quantity" if quantity else "unavailable",
        "close_minute": 960 if info["session"].startswith("0930-1600") else 0,
        "verified_frames": info.get("archive_verified_frames", {}),
        "market": info.get("exchange_code") or "Yahoo"}, row


def logical_symbol(source, symbol):
    if source == "akshare":
        from .akshare_catalog import logical_symbol as alias

        return alias(symbol)
    return "Y" + hashlib.sha256(symbol.encode()).hexdigest()[:9].upper()


def source_identity(parent, frame, info):
    if parent.source == "akshare":
        from .provider_akshare import collection_identity

        return collection_identity(parent, frame)
    return SourceIdentity(**{key: getattr(parent, key) for key in (
        "source", "channel", "environment", "account_scope", "provider_symbol", "basis")},
        parameters={"timeframe": frame, "endpoint": "yfinance.Ticker.history",
            "adjustment": parent.adjustment, "source_family": parent.source_family,
            "trading_date_rule": parent.trading_date_rule, "session": info["session"],
            "timezone": info["timezone"], "rules": "yfinance-archive-v1",
            "volume_kind": info["volume_kind"], "volume_unit": info.get("volume_unit")})


def available_frames(info, adjustment):
    verified = info.get("verified_frames", {}).get(adjustment, [])
    return [frame for frame in HISTORY_FRAMES if frame in verified]


def validate_frames(parent, info, selected):
    verified = available_frames(info, parent.adjustment)
    allowed = ["D1", "W1", "MN"] if parent.mode == "base_d1" and "D1" in verified else (
        verified if parent.mode == "native_periods" else [])
    selected = allowed if selected is None else selected
    if not selected or len(set(selected)) != len(selected) or not set(selected) <= set(allowed):
        raise ValueError("请选择此品种、接口与价格口径已验证的周期；可先显式验证来源能力")
    return selected


def register(db, identity, *, logical_symbol, precision, asset_class, timeframes=None, catalog_id=None):
    from .market_datasets import register_dataset
    from .source_registry import link_frame_source
    from .storage import MarketDataset

    info, entry = local_details(db, identity.source, identity.provider_symbol)
    if catalog_id is not None and entry.id != catalog_id:
        raise ValueError("来源目录身份不匹配")
    selected = validate_frames(identity, info, timeframes)
    profile = {"revision": identity.calendar_version, "trading_date": {
        "timezone": info["timezone"], "market": info.get("exchange", info.get("market", "Yahoo")),
        "rule": identity.trading_date_rule, "close_minute": info["close_minute"]}}
    inst = register_dataset(db, identity, logical_symbol=logical_symbol, label=entry.label,
        calendar="source_date", precision=precision, volume_kind=info["volume_kind"],
        volume_unit=info.get("volume_unit"), calendar_profile=profile, asset_class=asset_class)
    row = db.get(MarketDataset, identity.key)
    for frame in (["D1"] if identity.mode == "base_d1" else selected):
        link_frame_source(db, row, frame, source_identity(identity, frame, info))
    return row, inst


def probe_yahoo(symbol, frames, adjustment="none"):
    """Explicit verification reuses yfinance metadata and archive reading."""
    from .provider_capabilities import YAHOO_INTERVALS
    from .provider_yahoo import archive_page, stable_id
    from .yahoo_catalog import chart_metadata

    if not frames or len(frames) > 9 or not set(frames) <= set(YAHOO_INTERVALS):
        raise ValueError("请选择 Yahoo 支持的项目周期")
    parent = dataset_identity("yahoo", symbol, "native_periods", adjustment)
    chart_metadata(stable_id(symbol))  # Existing resolver, outside a transaction.
    with transaction() as db:
        info, _ = local_details(db, "yahoo", symbol)
    results = {}
    for frame in frames:
        try:
            batch = archive_page(source_identity(parent, frame, info), 946684800000, now_ms())
            valid = [row for row in batch.rows if row.complete]
            results[frame] = {"status": "verified" if valid else "unavailable",
                "observed_at": batch.observed_at, "rows": len(valid),
                "first": valid[0].start if valid else None, "last": valid[-1].end if valid else None}
        except Exception:
            results[frame] = {"status": "unavailable", "reason": "本次未返回可验证的有效闭合行情"}
    with transaction() as db:
        _, row = local_details(db, "yahoo", symbol)
        metadata = dict(row.metadata_json)
        verified = dict(metadata.get("archive_verified_frames", {}))
        current = set(verified.get(adjustment, [])) - set(frames)
        current.update(frame for frame, value in results.items() if value["status"] == "verified")
        verified[adjustment] = [frame for frame in HISTORY_FRAMES if frame in current]
        row.metadata_json = {**metadata, "archive_verified_frames": verified,
            "archive_probes": {**metadata.get("archive_probes", {}), adjustment: results}}
    return {"source": "yahoo", "provider_symbol": symbol, "adjustment": adjustment,
        "frames": verified[adjustment], "results": results}
