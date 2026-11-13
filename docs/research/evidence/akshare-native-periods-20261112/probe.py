"""Read-only direct-period probes. No local candle aggregation or SDK imports.

Run in the existing pinned image, isolated network and no database mounts.
Only explicit minute enum values route to the Tencent minute endpoint.
"""

import datetime as dt
import json
import sys
import time
from decimal import Decimal

import requests


def describe(rows, fields):
    if not rows:
        return {"rows": 0}
    normalized = [dict(zip(fields, row[:len(fields)])) if isinstance(row, list) else row for row in rows]
    label = "day" if "day" in normalized[0] else "date"
    labels = [str(row[label]) for row in normalized]
    invalid, nonpositive = 0, 0
    for row in normalized:
        o, h, l, c = (Decimal(str(row[k])) for k in ("open", "high", "low", "close"))
        invalid += not (all(v.is_finite() for v in (o, h, l, c)) and h >= max(o, l, c) and l <= min(o, h, c))
        nonpositive += any(v <= 0 for v in (o, h, l, c))
    return {"rows": len(rows), "first": labels[0], "last": labels[-1],
            "unique_labels": len(set(labels)) == len(labels), "ordered": labels == sorted(labels),
            "invalid_ohlc": invalid, "nonpositive_price_rows": nonpositive,
            "first_rows": normalized[:2], "last_rows": normalized[-2:],
            "last_8_labels": labels[-8:]}


def probe_sina(symbol, scale):
    url = "https://quotes.sina.cn/cn/api/jsonp_v2.php/=/CN_MarketDataService.getKLineData"
    params = {"symbol": symbol, "scale": scale, "ma": "no", "datalen": "80"}
    response = requests.get(url, params=params, timeout=12)
    response.raise_for_status()
    data = json.loads(response.text.split("=(", 1)[1].rsplit(");", 1)[0])
    return {"url": url, "params": params, "payload_type": type(data).__name__,
            **describe(data if isinstance(data, list) else [], [])}


def probe_tencent(symbol, period, adjustment=""):
    if period in ("m1", "m5", "m15", "m30", "m60"):
        assert not adjustment
        url = "https://ifzq.gtimg.cn/appstock/app/kline/mkline"
        params = {"param": f"{symbol},{period},,80"}
    else:
        assert period in ("day", "week", "month")
        if symbol.startswith("hk"):
            url = "https://web.ifzq.gtimg.cn/appstock/app/hkfqkline/get" if adjustment else "https://web.ifzq.gtimg.cn/appstock/app/kline/kline"
        else:
            url = "https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get"
        params = {"param": f"{symbol},{period},,,80,{adjustment}"}
    response = requests.get(url, params=params, timeout=12)
    response.raise_for_status()
    payload = response.json()
    obj = payload.get("data", {}).get(symbol, {}) if isinstance(payload.get("data"), dict) else {}
    key = next((k for k in (adjustment + period, period) if isinstance(obj.get(k), list)), None)
    records = obj[key] if key else []
    return {"url": url, "params": params, "upstream_code": payload.get("code"), "series_key": key,
            **describe(records, ["date", "open", "close", "high", "low", "volume"])}


def emit(case, call):
    started = time.monotonic()
    try:
        result = call()
        ok = result.get("rows", 0) > 0 and result.get("upstream_code", 0) == 0
        out = {"case": case, "status": "ohlc_observed" if ok else "no_ohlc", **result}
    except Exception as exc:
        out = {"case": case, "status": "error", "error": type(exc).__name__}
    out["seconds"] = round(time.monotonic() - started, 3)
    print(json.dumps(out, ensure_ascii=False), flush=True)


print(json.dumps({"observed_at_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
                  "mode": "direct upstream periods; no local aggregation", "group": sys.argv[1]}), flush=True)

if sys.argv[1] == "sina_a":
    for symbol in ("sh600519", "sz000001"):
        for scale in ("1", "5", "15", "30", "60", "240", "1200", "7200"):
            emit(f"sina-a:{symbol}:scale={scale}", lambda s=symbol, p=scale: probe_sina(s, p))
elif sys.argv[1] == "tencent":
    for symbol in ("sz000001", "sh600519", "hk00700", "hk02318"):
        periods = ("m1", "m5", "m15", "m30", "m60", "day", "week", "month") if not symbol.startswith("hk") else ("day", "week", "month")
        for period in periods:
            emit(f"tencent:{symbol}:{period}:raw", lambda s=symbol, p=period: probe_tencent(s, p))
        for period in ("day", "week", "month"):
            emit(f"tencent:{symbol}:{period}:qfq", lambda s=symbol, p=period: probe_tencent(s, p, "qfq"))
elif sys.argv[1] == "sina_hk_candidates":
    for symbol in ("hk00700", "rt_hk00700", "00700"):
        emit(f"sina-cn-route:{symbol}:scale=1200", lambda s=symbol: probe_sina(s, "1200"))
