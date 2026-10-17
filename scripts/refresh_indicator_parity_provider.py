"""Publish a current synthetic tail through the real cache writer; no supplier I/O."""

import argparse
import math
import time

from alerts import provider_cache as cache
from alerts.config import settings
from alerts.provider_chart import metadata
from alerts.storage import Preference, ProviderBar, now_ms, transaction
from sqlalchemy import func, select
from sqlalchemy.engine import make_url


def refresh():
    url = make_url(settings.database_url)
    if (url.host != "pg" or url.database != "indicator_parity" or
            settings.database_application_name != "mw-issue74-20261017" or
            settings.delivery_enabled or settings.oanda_token or settings.yahoo_enabled):
        raise RuntimeError("Requires isolated #74 fixture; external delivery/suppliers disabled")
    with transaction() as db:
        marker = db.get(Preference, "acceptance.indicator-parity.20261017")
        if not marker or not marker.value.get("synthetic"):
            raise RuntimeError("Seed the named synthetic fixture first")
    stamp = now_ms()
    for frame, width in (("M1", 60000), ("H1", 3600000)):
        key = cache.ensure(metadata("BTCUSDT"), frame)
        with transaction() as db:
            origin, last = db.execute(select(func.min(ProviderBar.start), func.max(ProviderBar.start))
                .where(ProviderBar.dataset_id == key)).one()
        if origin is None or last < stamp - 7 * 86400000:
            raise RuntimeError("Missing or unexpectedly old synthetic provider inputs")
        rows = []
        for at in range(last, stamp // width * width + 1, width):
            index = (at - origin) // width
            price = 100 + math.sin(index / 7) * 5 + index / 100
            rows.append(dict(start=at, end=at + width, chart_time=at, open=str(price),
                high=str(price + 2), low=str(price - 2), close=str(price + 1),
                complete=at + width <= stamp, volume="10", volume_kind="quantity", volume_unit="source_quantity"))
        owner = cache.claim(key)
        if owner:
            try:
                cache.commit_page(key, owner, {"bars": rows, "history_boundary": False}, stamp + 1, stamp, latest=True)
            finally:
                cache.release(key, owner)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--loop", action="store_true")
    args = parser.parse_args()
    while True:
        refresh()
        if not args.loop:
            break
        time.sleep(2)
