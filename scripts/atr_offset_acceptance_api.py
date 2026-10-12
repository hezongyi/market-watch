"""Synthetic supplier for the named Ubuntu ATR acceptance instance only.

The actual API, provider cache/collection, alert transaction and notification
worker stay in use. Never mount this adapter into a production service.
"""

import json
import os
import sys
import time
from pathlib import Path

from alerts import provider_chart
from alerts.composite_series import period
from alerts.storage import now_ms

STATE = Path("/fixture-state")
DAY = 86400000
GENESIS = now_ms() // DAY * DAY - 200 * DAY


def native_page(meta, frame, before, count, **_):
    if meta["source"] != "binance" or meta["symbol"] != "BTCUSDT":
        raise ValueError("ATR acceptance supplier serves only Binance BTCUSDT")
    control = json.loads((STATE / "control.json").read_text()) if (STATE / "control.json").exists() else {}
    now = now_ms()
    cursor = min(before - 1, now)
    rows = []
    for _ in range(count):
        left, right = period(cursor, frame, "utc0")
        if left < GENESIS:
            break
        complete = right <= now
        close = str(control.get("price", "100")) if not complete else "100"
        rows.append(dict(start=left, end=right, chart_time=left, open="100",
            high=str(max(102, float(close))), low="98", close=close,
            complete=complete, volume="5", volume_complete=complete))
        cursor = left - 1
    with (STATE / "supplier-calls.jsonl").open("a") as stream:
        stream.write(json.dumps(dict(time=now, frame=frame, count=count,
            role=sys.argv[1], pid=os.getpid())) + "\n")
    return dict(bars=rows[::-1], history_boundary=cursor < GENESIS)


provider_chart.native_page = native_page
provider_chart.warm_clients = lambda: None

if __name__ == "__main__":
    if sys.argv[1] == "api":
        import uvicorn
        uvicorn.run("alerts.api:app", host="0.0.0.0", port=8000)
    elif sys.argv[1] == "worker":
        from alerts.chart_alert_worker import step
        from alerts.native_history_loads import once
        from alerts.provider_service import realtime_step
        while True:
            once()
            realtime_step("binance")
            step()
            time.sleep(1)
    else:
        raise SystemExit("Expected api or worker")
