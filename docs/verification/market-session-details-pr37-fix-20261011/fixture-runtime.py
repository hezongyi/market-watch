"""Acceptance-only provider fixture, mounted into an isolated Ubuntu project.

Synthetic prices prove rendering/identity behavior, not provider availability or
official trading hours. No production module imports this harness.
"""

import runpy
import sys
from datetime import UTC, datetime, timedelta

from alerts import market_data, provider_chart, provider_transport
from alerts.storage import bootstrap, now_ms
from alerts.volume import metadata as volume_metadata

SATURDAY = int(datetime(2026, 10, 10, 12, tzinfo=UTC).timestamp() * 1000)
FRIDAY_CLOSE = int(datetime(2026, 10, 9, 21, tzinfo=UTC).timestamp() * 1000)
BEGIN = int(datetime(2024, 1, 1, tzinfo=UTC).timestamp() * 1000)


def native_page(meta, frame, before, count, **kwargs):
    width = provider_chart.FRAME_MS[frame]
    limit = now_ms() if meta["source"] == "binance" else FRIDAY_CLOSE
    right = min(before, limit)
    latest = BEGIN + (right - 1 - BEGIN) // width * width
    if frame == "MN":
        last = datetime.fromtimestamp((right - 1) / 1000, UTC).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        starts = []
        while len(starts) < count and int(last.timestamp() * 1000) >= BEGIN:
            starts.append(int(last.timestamp() * 1000))
            last = (last - timedelta(days=1)).replace(day=1)
        starts.reverse()
    else:
        starts = list(range(max(BEGIN, latest - (count - 1) * width), latest + 1, width))
    bars = []
    from alerts.provider_dukascopy import interval_end
    for start in starts:
        end = interval_end(start, frame)
        price = 4000 + (start // 60000 % 100) / 100
        bars.append({"start": start, "end": end, "chart_time": start,
                     "open": str(price), "high": str(price + 1), "low": str(price - 1),
                     "close": str(price + .25), "volume": "100", "volume_complete": True,
                     "complete": end <= limit})
    boundary = not bars or bars[0]["start"] <= BEGIN
    return {"bars": bars, "history_boundary": boundary, "has_more": not boundary,
            "coverage": [[bars[0]["start"] if bars else 0, before]], "as_of": now_ms(),
            "series_kind": "provider", "basis": meta["basis"], "calendar": meta["calendar"],
            "precision": meta["precision"], "indicators": [], **volume_metadata(meta["source"], meta["symbol"])}


provider_chart.native_page = native_page
provider_chart.warm_clients = lambda: None
provider_transport.warm_connections = lambda *args: None
market_data.now_ms = lambda: SATURDAY
bootstrap()
mode = sys.argv[1]
if mode == "api":
    import uvicorn

    uvicorn.run("alerts.api:app", host="0.0.0.0", port=8000)
elif mode == "native":
    runpy.run_module("alerts.native_history_loads", run_name="__main__")
elif mode == "stream":
    runpy.run_module("alerts.market_stream_worker", run_name="__main__")
else:
    raise ValueError("Unknown isolated fixture mode")
