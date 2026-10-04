"""Fetch actual Binance candles into this task's dedicated local DB only."""

import json
import time

from alerts import provider_cache, provider_chart
from alerts.config import settings
from alerts.storage import now_ms
from sqlalchemy.engine import make_url

url = make_url(settings.database_url)
assert url.host == "pg" and url.database == "indicator_acceptance"
assert settings.database_application_name == "mw-indicator-acceptance"
assert not settings.delivery_enabled
meta = provider_chart.metadata("BTCUSDT")
started = time.monotonic()
page = provider_cache.read(
    meta, "M5", (now_ms() // 1000 + 1) * 1000, 2000, latest=True, deadline=started + 90
)
assert len(page["bars"]) >= 500, "Need actual provider candles for indicator acceptance"
print(
    json.dumps(
        {
            "source": meta["source"],
            "symbol": "BTCUSDT",
            "timeframe": "M5",
            "count": len(page["bars"]),
            "first": page["bars"][0]["chart_time"],
            "last": page["bars"][-1]["chart_time"],
            "seconds": round(time.monotonic() - started, 3),
        }
    )
)
provider_chart.close_clients()
