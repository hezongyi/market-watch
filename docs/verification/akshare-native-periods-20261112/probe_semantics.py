"""Read-only count/label/volume observations; no candles served from reductions."""

import json
import sys
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

import httpx
from alerts.akshare_native import COUNTS, fetch, native_metadata

result = {"observed_at": datetime.now(UTC).isoformat(), "counts": [], "quotes": []}
for family, symbol in (("sina-a", "SZSE:000001"), ("tencent-a", "SZSE:000001"),
                       ("tencent-hk", "HKEX:00700")):
    meta = native_metadata(family)
    for frame in meta["frames"]:
        for count in (2, 80, COUNTS[family]):
            rows = fetch(meta["native_operation"], symbol, frame, count)
            assert 1 < len(rows) <= count
            result["counts"].append({"family": family, "symbol": symbol, "frame": frame,
                "requested": count, "received": len(rows), "first_label": rows[0]["date"],
                "last_label": rows[-1]["date"]})
    latest = fetch(meta["native_operation"], symbol, "D1", 2)[-1]
    if family == "sina-a":
        text = httpx.get("https://hq.sinajs.cn/list=sz000001", timeout=12,
            headers={"Referer": "https://finance.sina.com.cn/"}).content.decode("gb18030")
        fields = text.split('"')[1].split(',')
        price, volume, day = fields[3], fields[8], fields[30]
        origin = "Sina mainland quote: totalVolume shares"
    else:
        code = "sz000001" if family == "tencent-a" else "hk00700"
        text = httpx.get("https://qt.gtimg.cn/q=" + code, timeout=12).content.decode("gb18030")
        fields = text.split('"')[1].split('~')
        price, volume, day = fields[3], fields[6], fields[30]
        origin = "Tencent mainland quote: lots (100 shares)" if family == "tencent-a" else "Tencent HK quote: shares"
    assert Decimal(latest["close"]) == Decimal(price)
    assert Decimal(latest["volume"]) == Decimal(volume)
    minute = fetch(meta["native_operation"], symbol, "H1", 4) if family != "tencent-hk" else []
    result["quotes"].append({"family": family, "symbol": symbol, "quote_time": day,
        "origin": origin, "daily_close": latest["close"], "daily_volume": latest["volume"],
        "quote_close": price, "quote_volume": volume, "hourly_samples": minute,
        "unit": meta["volume_unit"]})
# This equality only verifies unit semantics against independent quote fields.
# No sum or derived candle from this script is used by the application.
sina, tx = result["quotes"][:2]
assert abs(Decimal(sina["daily_volume"]) / Decimal(tx["daily_volume"]) - 100) < Decimal("0.01")
result["passed"] = True
Path(sys.argv[1]).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"passed": True, "count_cases": len(result["counts"]), "volume_cases": len(result["quotes"])}))
