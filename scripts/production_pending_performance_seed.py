"""A larger, deterministic synthetic source for task-local pagination timing."""
import hashlib
import json
import math
import os
import sys

from sqlalchemy import select
from sqlalchemy.engine import make_url

from alerts.config import settings
from alerts import provider_cache as cache
from alerts.provider_chart import metadata
from alerts.storage import ProviderBar, ProviderDataset, now_ms, transaction

url = make_url(settings.database_url)
if (os.environ.get("MW_PENDING_ACCEPTANCE_TASK") != "mw-pending-fixes-20261013"
        or url.host != "pg" or url.database != "production_ux_acceptance"
        or settings.delivery_enabled or settings.oanda_token or settings.yahoo_enabled):
    raise RuntimeError("Requires task-local synthetic acceptance configuration")

stamp = now_ms()
checking = "--check" in sys.argv
end = int(os.environ["MW_PENDING_SOURCE_END"]) if checking else stamp // 300000 * 300000 + 300000
meta = metadata("BTCUSDT")
bars = []
for index, start in enumerate(range(end - 12000 * 300000, end, 300000)):
    value = round(84000 + math.sin(index / 19) * 120 + index / 100, 5)
    bars.append(dict(start=start, end=start + 300000, chart_time=start,
                     open=str(value), high=str(value + 20), low=str(value - 20),
                     close=str(value + 5), complete=start + 300000 <= stamp,
                     volume="100", volume_kind="quantity", volume_unit="source_quantity"))
key = cache.ensure(meta, "M5")
if not checking:
    lease = cache.claim(key)
    if lease is None:
        raise RuntimeError("Task synthetic series has an active lease")
    try:
        # Use the same bounded page size as the real provider. One giant insert
        # would exceed PostgreSQL's parameter limit and would not model production.
        for offset in range(0, len(bars), 1000):
            page = bars[offset:offset + 1000]
            cache.commit_page(key, lease, {"bars": page, "history_boundary": offset == 0},
                              page[-1]["end"], stamp, latest=offset + 1000 == len(bars))
    finally:
        cache.release(key, lease)
with transaction() as db:
    if not checking:
        db.get(ProviderDataset, key).latest_at = stamp + 3600000
    stored = list(db.scalars(select(ProviderBar).where(ProviderBar.dataset_id == key,
        ProviderBar.start >= bars[0]["start"], ProviderBar.start < end).order_by(ProviderBar.start)))
    if len(stored) != 12000:
        raise RuntimeError("Task synthetic source did not persist all requested bars")
    digest = hashlib.sha256(json.dumps([row.payload for row in stored], sort_keys=True).encode()).hexdigest()
print(json.dumps(dict(scope="synthetic task-local M5; no source or coverage evidence", count=12000,
                      start=bars[0]["start"], end=end, content_sha256=digest)))
