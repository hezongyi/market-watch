"""Synthetic observed inputs; refuses shared/production instances."""

import json
import math
import os
import sys
from decimal import Decimal

sys.path.insert(0, "/app/backend/tests")
from alerts.config import settings
from alerts.history_artifacts import artifact_tick, request_artifacts
from alerts.history_versions import create_version, import_page
from alerts.storage import HistoryVersion, Preference, transaction
from sqlalchemy.engine import make_url
from test_history_versions import Adapter
from test_market_contracts import batch, identity, minute
from test_market_datasets import register

assert os.environ.get("MW_PREVIEW_TASK") == "mw-python-indicators-20261022"
assert make_url(settings.database_url).host == "postgres"
assert not settings.oanda_stream_enabled and not settings.delivery_enabled
start = 1788300000000
end = start + 24 * 86400000
result = {}
for symbol, scale in [("EURUSD", 1), ("XAUUSD", 2000)]:
    ident = identity(provider_symbol="EUR/USD" if scale == 1 else "XAU/USD")
    with transaction() as db:
        register(db, ident, logical_symbol=symbol, precision=5 if scale == 1 else 2)
        key = "python_indicator_fixture:" + symbol
        old = db.get(Preference, key)
        if old:
            result[symbol] = old.value["version"]
            continue
        version = create_version(db, ident.key, start, end)
    rows = []
    # Missing minutes are deliberate coverage evidence, never invented full days.
    for at in range(start, end, 3600000):
        n = (at - start) // 3600000
        close = Decimal(str(scale * (1.1 + 0.02 * math.sin(n / 23))))
        rows.append(
            minute(
                at,
                open=str(close),
                high=str(close + Decimal(str(0.005 * scale))),
                low=str(close - Decimal(str(0.005 * scale))),
                close=str(close),
            )
        )
    import_page(
        Adapter(
            [
                batch(
                    identity=ident,
                    window_start=start,
                    window_end=end,
                    checkpoint=end,
                    observed_at=end + 1000,
                    rows=tuple(rows),
                )
            ]
        ),
        version_id=version,
    )
    with transaction() as db:
        request_artifacts(db, db.get(HistoryVersion, version), ["M1", "H1", "H4", "D1", "W1", "MN"])
    while artifact_tick(version):
        pass
    with transaction() as db:
        db.add(Preference(key=key, value={"version": version}))
    result[symbol] = version
print(json.dumps(result))
