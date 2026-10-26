"""Run in the candidate backend; bounded real Sina observations, no database writes."""

import json
import time
from decimal import Decimal

from alerts.history_mode_sources import dataset_identity
from alerts.provider_akshare import collection_identity, invoke, parse_records, parse_sina_factors
from alerts.storage import now_ms

report = []
for symbol, api_symbol, endpoint in [
    ("SZSE:000001", "sz000001", "stock_zh_a_daily"),
    ("SSE:600519", "sh600519", "stock_zh_a_daily"),
    ("HKEX:00700", "00700", "stock_hk_daily"),
]:
    started = time.monotonic()
    raw, factors, qfq = [
        invoke(endpoint, {"symbol": api_symbol, "adjust": adjust}, deadline=time.monotonic() + 30)
        for adjust in ("", "qfq-factor", "qfq")
    ]
    identity = collection_identity(
        dataset_identity("akshare", symbol, "native_periods", "none"), "D1"
    )
    rows = parse_records(identity, raw, start=1704067200000, end=now_ms(), observed_at=now_ms())
    rows = parse_sina_factors(factors, rows)
    adjusted = {str(row["date"])[:10]: row for row in qfq}
    maximum = Decimal(0)
    checked = 0
    for row in rows:
        other = adjusted.get(row.trading_date)
        if not other:
            continue
        factor = Decimal(row.adjustment_basis["value"])
        for field in ("open", "high", "low", "close"):
            price = Decimal(str(getattr(row, field)))
            own = price * factor if symbol.startswith("HKEX:") else price / factor
            error = abs(own - Decimal(str(other[field])))
            maximum = max(maximum, error)
            checked += 1
    tolerance = Decimal("0.0001") if symbol.startswith("HKEX:") else Decimal("0.011")
    assert checked > 1000 and maximum <= tolerance, (symbol, maximum)
    report.append(
        {
            "symbol": symbol,
            "endpoint": endpoint,
            "raw_rows": len(raw),
            "factor_events": len(factors),
            "supplier_qfq_rows": len(qfq),
            "checked_ohlc": checked,
            "maximum_absolute_error": str(maximum),
            "tolerance": str(tolerance),
            "basis_values": len({row.adjustment_basis["value"] for row in rows}),
            "first": rows[0].trading_date,
            "last": rows[-1].trading_date,
            "elapsed_seconds": round(time.monotonic() - started, 3),
            "passed": True,
        }
    )
print(json.dumps({"passed": True, "cases": report}, indent=2))
