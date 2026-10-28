"""Synthetic native-chart prices for this patch's Ubuntu notification smoke."""

import os

from alerts import provider_cache as cache
from alerts.config import settings
from alerts.provider_chart import metadata
from alerts.storage import AdvancedWorkspace, ProviderDataset, now_ms, transaction
from sqlalchemy.engine import make_url

TASK = "mw-chart-live-fix-20261028"


def seed():
    url = make_url(settings.database_url)
    if (os.environ.get("MW_PREVIEW_TASK") != TASK
            or settings.database_application_name != TASK
            or url.host != "postgres" or url.database != "preview"
            or settings.delivery_enabled or settings.yahoo_enabled
            or settings.oanda_stream_enabled or settings.oanda_token):
        raise ValueError("Requires this patch's isolated Ubuntu preview")
    stamp = now_ms()
    meta = metadata("BTCUSDT")
    for frame, width in (("M1", 60000), ("M5", 300000), ("H1", 3600000),
                         ("H4", 14400000), ("D1", 86400000)):
        end = stamp // width * width + width
        bars = []
        for index, start in enumerate(range(end - 1500 * width, end, width)):
            value = 80000 + (index % 20 - 10) * 25
            bars.append({"start": start, "end": start + width, "chart_time": start,
                "open": str(value), "high": str(value + 40), "low": str(value - 40),
                "close": str(value + 20), "complete": start + width <= stamp,
                "volume": "100", "volume_kind": "quantity", "volume_unit": "source_quantity"})
        key = cache.ensure(meta, frame)
        lease = cache.claim(key)
        if not lease:
            raise RuntimeError("Synthetic cache is already leased")
        try:
            cache.commit_page(key, lease, {"bars": bars, "history_boundary": True}, end, stamp, latest=True)
        finally:
            cache.release(key, lease)
        with transaction() as db:
            # A bounded UI fixture, not evidence of supplier availability.
            db.get(ProviderDataset, key).latest_at = stamp + 3600000
    with transaction() as db:
        ident = "notification-startup-synthetic"
        if not db.get(AdvancedWorkspace, ident):
            db.add(AdvancedWorkspace(id=ident, name="Notification startup synthetic BTC",
                document={"engine": "tv31", "schemaVersion": 1, "symbol": "MWP:BTCUSDT",
                    "series_kind": "provider", "interval": "60"}))
    print("Task-only synthetic BTC cache/workspace ready; no supplier validation claim")


if __name__ == "__main__":
    seed()
