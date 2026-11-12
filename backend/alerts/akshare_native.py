"""Fixed Sina/Tencent raw-period routes, used only by native platform aliases.

Each response already contains the requested period. No resampling or price
adjustment is performed here; legacy SDK/managed identities remain separate.
"""

import json
import re
from datetime import datetime

import httpx

RULES = "sina-tencent-direct-raw-close-label-v1"
PREFIXES = ("SINA-NATIVE:", "TENCENT-NATIVE:")
OPERATIONS = {"sina-a": "native_sina_a", "tencent-a": "native_tencent_a",
              "tencent-hk": "native_tencent_hk"}
MINUTES = {"M1": "1", "M5": "5", "M15": "15", "M30": "30", "H1": "60"}
PERIODS = {"D1": "day", "W1": "week", "MN": "month"}
SCALES = {**MINUTES, "D1": "240", "W1": "1200", "MN": "7200"}
SINA_URL = "https://quotes.sina.cn/cn/api/jsonp_v2.php/=/CN_MarketDataService.getKLineData"
TENCENT_MINUTE_URL = "https://ifzq.gtimg.cn/appstock/app/kline/mkline"
TENCENT_A_URL = "https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get"
TENCENT_HK_URL = "https://web.ifzq.gtimg.cn/appstock/app/kline/kline"
# Bounded successful snapshots; not claims of upstream capacity or full history.
COUNTS = {"sina-a": 1970, "tencent-a": 800, "tencent-hk": 800}


def variant(ident):
    if not ident.startswith(PREFIXES):
        return None
    prefix, symbol = ident.split(":", 1)
    exchange, _, code = symbol.partition(":")
    if exchange in ("SSE", "SZSE") and re.fullmatch(r"\d{6}", code):
        return ("sina-a" if prefix == "SINA-NATIVE" else "tencent-a"), symbol
    if prefix == "TENCENT-NATIVE" and exchange == "HKEX" and re.fullmatch(r"\d{5}", code):
        return "tencent-hk", symbol
    raise ValueError("原生平台入口只支持新浪/腾讯沪深股票或腾讯港股")


def native_metadata(family):
    if family not in OPERATIONS:
        raise ValueError("未知原生行情来源")
    return {"source_family": family, "native_operation": OPERATIONS[family],
        "native_rules": RULES, "adjustment": "none", "volume_kind": "quantity",
        "volume_unit": "lots" if family == "tencent-a" else "shares",
        "quality_note": "新浪个别早期周月线的 OHLC 无效；图表保留缺口，不修补价格。" if family == "sina-a" else None,
        "frames": list(PERIODS) if family == "tencent-hk" else list(SCALES)}


def route(operation, symbol, frame, count):
    family = next((key for key, value in OPERATIONS.items() if value == operation), None)
    if family is None or type(count) is not int or not 1 <= count <= COUNTS[family]:
        raise ValueError("无效原生请求")
    prefix = "SINA-NATIVE:" if family == "sina-a" else "TENCENT-NATIVE:"
    resolved, _ = variant(prefix + symbol)
    if resolved != family or frame not in native_metadata(family)["frames"]:
        raise ValueError("来源没有此原生周期接口")
    exchange, code = symbol.split(":")
    supplier = {"SSE": "sh", "SZSE": "sz", "HKEX": "hk"}[exchange] + code
    if family == "sina-a":
        return SINA_URL, {"symbol": supplier, "scale": SCALES[frame], "ma": "no", "datalen": str(count)}
    if frame in MINUTES:
        return TENCENT_MINUTE_URL, {"param": f"{supplier},m{MINUTES[frame]},,{count}"}
    return (TENCENT_HK_URL if family == "tencent-hk" else TENCENT_A_URL,
            {"param": f"{supplier},{PERIODS[frame]},,,{count},"})


def parse_response(operation, symbol, frame, text):
    if operation == "native_sina_a":
        # Fixed callback '=('; never execute upstream JavaScript.
        match = re.fullmatch(r"\s*(?:/\*.*?\*/\s*)?=\((.*)\);?\s*", text, re.S)
        if not match:
            raise ValueError("新浪响应包装无效")
        records = json.loads(match[1])
        if not isinstance(records, list):
            raise ValueError("新浪未返回对应周期数组")
        return [{**row, "date": row["day"]} for row in records]
    data = json.loads(text)
    if data.get("code") != 0:
        raise ValueError("腾讯行情业务请求失败")
    exchange, code = symbol.split(":")
    supplier = {"SSE": "sh", "SZSE": "sz", "HKEX": "hk"}[exchange] + code
    period = "m" + MINUTES[frame] if frame in MINUTES else PERIODS[frame]
    records = data.get("data", {}).get(supplier, {}).get(period)
    if not isinstance(records, list):
        raise ValueError("腾讯未返回所选股票的原生不复权周期")
    result = []
    for row in records:
        if not isinstance(row, list) or len(row) < 6:
            raise ValueError("腾讯 OHLCV 字段缺失")
        label = row[0]
        if frame in MINUTES:
            label = datetime.strptime(label, "%Y%m%d%H%M").isoformat(sep=" ")
        result.append(dict(zip(("date", "open", "close", "high", "low", "volume"),
                               (label, *row[1:6]))))
    return result


def fetch(operation, symbol, frame, count, *, timeout=12):
    url, parameters = route(operation, symbol, frame, count)
    response = httpx.get(url, params=parameters, timeout=min(12, timeout))
    response.raise_for_status()
    if len(response.content) > 8 * 1024 * 1024:
        raise ValueError("原生行情响应超出有界容量")
    return parse_response(operation, symbol, frame, response.text)


def source_identity(meta, frame):
    from .market_contracts import SourceIdentity

    family = meta["source_family"]
    values = native_metadata(family)
    route(values["native_operation"], meta["symbol"], frame, COUNTS[family])
    return SourceIdentity(source="akshare", channel="python", environment="public",
        account_scope="public", provider_symbol=meta["symbol"], basis="last",
        parameters={"timeframe": frame, "endpoint": values["native_operation"],
            "adjustment": "none", "source_family": family, "rules": RULES,
            "snapshot_count": COUNTS[family], "trading_date_rule": "supplier-trading-date-v1",
            "session": family + "-regular", "timezone": "Asia/Hong_Kong" if family == "tencent-hk" else "Asia/Shanghai"})


def platform_page(meta, frame, before, count, *, deadline=None, optional=0):
    from .market_contracts import NativeCandleBatch
    from .provider_akshare import invoke, parse_records
    from .source_history_store import shared_native_page
    from .storage import now_ms

    if frame not in meta["frames"] or not 1 <= count <= 4000:
        raise ValueError("此品种不支持所选原生周期")
    source = source_identity(meta, frame)
    observed = now_ms()
    # One fixed observation window per UTC day. Cursors share the full snapshot,
    # including across minute boundaries; old pages do not refresh a closed tail.
    window_end = (observed // 86400000 + 1) * 86400000

    class Snapshot:
        def native_page(self, identity, start, end):
            records = invoke(source.parameters["endpoint"], {"symbol": meta["symbol"],
                "frame": frame, "count": source.parameters["snapshot_count"]}, deadline=deadline)
            fetched = now_ms()
            warnings = []
            rows = parse_records(source, records, start=start, end=end, observed_at=fetched,
                                 invalid_records=warnings)
            return NativeCandleBatch(identity=identity, timeframe=frame, window_start=start,
                window_end=end, checkpoint=end, observed_at=fetched, rows=rows,
                result={"status": "data" if rows else "empty_success"},
                volume_kind="quantity", volume_unit=meta["volume_unit"], source_warnings=warnings)

    historical = before < observed - 86400000
    batch = shared_native_page(Snapshot(), source, 0, window_end,
        fresh_after=0 if historical else observed - 60000,
        volume_kind="quantity", volume_unit=meta["volume_unit"])
    bars = [{**row.model_dump(), "chart_time": row.start,
             "volume_complete": row.complete and row.volume is not None}
            for row in batch.rows if row.start < before]
    visible = bars[-min(4000, count + optional):]
    boundary = {"kind": "rolling_window", "left": batch.rows[0].start,
        "confirmed_at": batch.observed_at, "retry_at": window_end,
        "reason": "source_snapshot_window"} if batch.rows else None
    return {"bars": visible, "has_more": len(bars) > len(visible), "history_boundary": False,
        "boundary_evidence": boundary, "availability": "observed_window",
        "coverage": [[visible[0]["start"], min(before, observed)]] if visible else [],
        "series_kind": "provider", "basis": "last", "calendar": "source_date",
        "precision": meta["precision"], "indicators": [], "volume_kind": "quantity",
        "volume_unit": meta["volume_unit"], "as_of": batch.observed_at,
        "source_warnings": list(batch.source_warnings)}
