"""Only this task's isolated PostgreSQL; no production config or notifications."""

import sys

from alerts.config import settings
from sqlalchemy.engine import make_url

url = make_url(settings.database_url)
if (
    url.host != "pg"
    or url.database != "production_ux_acceptance"
    or settings.delivery_enabled
    or settings.oanda_token
    or settings.yahoo_enabled
):
    raise RuntimeError("Requires the isolated production UX acceptance configuration")

if sys.argv[1] == "chart-worker":
    from alerts import chart_history_worker

    # This UI/heartbeat fixture does not exercise the upstream account catalog.
    # Keep the actual business cycle and database-backed executor unchanged.
    chart_history_worker.refresh_catalog = lambda: None
    chart_history_worker.main()
elif sys.argv[1] == "seed":
    from alerts.market_contracts import DatasetIdentity
    from alerts.market_datasets import register_dataset
    from alerts.provider_dukascopy import stable_id
    from alerts.storage import AdvancedWorkspace, MarketCatalog, bootstrap, transaction

    bootstrap()
    with transaction() as db:
        for symbol in ("XAUUSD", "EURUSD"):
            identity = DatasetIdentity(
                source="oanda",
                channel="v20",
                environment="practice",
                account_scope="sha256:" + "a" * 64,
                provider_symbol=symbol[:3] + "_" + symbol[3:],
                basis="bid",
                calendar_version="ux-fixture-ny17-v1",
            )
            inst = register_dataset(
                db,
                identity,
                logical_symbol=symbol,
                label=symbol + " · OANDA practice",
                calendar="ny17",
                precision=2 if symbol == "XAUUSD" else 5,
                volume_kind="price_count",
                volume_unit="quotes",
            )
            inst.enabled = True
        if not db.get(MarketCatalog, "UX:BTCUSDT"):
            db.add(
                MarketCatalog(
                    id="UX:BTCUSDT",
                    source="binance",
                    symbol="BTCUSDT",
                    label="Bitcoin fixture",
                    asset_type="CRYPTO",
                    calendar="utc0",
                    precision=2,
                )
            )
        if not db.get(AdvancedWorkspace, "ux-synthetic-native"):
            db.add(
                AdvancedWorkspace(
                    id="ux-synthetic-native",
                    name="Ubuntu UX synthetic chart",
                    document={
                        "engine": "tv31",
                        "schemaVersion": 1,
                        "symbol": "MWP:" + stable_id("EUR/USD"),
                        "series_kind": "provider",
                    },
                )
            )
    print("Isolated UX fixture seeded; no upstream demand or notification enabled")
elif sys.argv[1] == "chart-seed":
    from alerts import provider_cache as cache
    from alerts.provider_dukascopy import metadata, stable_id
    from alerts.storage import ProviderDataset, now_ms, transaction

    # Explicitly synthetic cache for native UI/axis behavior, never evidence of
    # supplier availability or prices. Only this task's database is reachable.
    stamp = now_ms()
    for symbol, price in (("EUR/USD", 1.12), ("AAPL.US/USD", 320)):
        meta = metadata(stable_id(symbol))
        for frame, width in (("H4", 14400000), ("D1", 86400000), ("M5", 300000)):
            end = stamp // width * width + width
            bars = []
            for index, start in enumerate(range(end - 1500 * width, end, width)):
                value = price * (1 + (index % 20 - 10) / 1000)
                bars.append(
                    {
                        "start": start,
                        "end": start + width,
                        "chart_time": start,
                        "open": str(value),
                        "high": str(value * 1.002),
                        "low": str(value * 0.998),
                        "close": str(value * 1.001),
                        "complete": start + width <= stamp,
                        "volume": "100",
                        "volume_kind": "quantity",
                        "volume_unit": "source_quantity",
                    }
                )
            key = cache.ensure(meta, frame)
            lease = cache.claim(key)
            if lease is None:
                raise RuntimeError("Synthetic chart seed is already leased")
            cache.commit_page(
                key, lease, {"bars": bars, "history_boundary": True}, end, stamp, latest=True
            )
            cache.release(key, lease)
            # Keep the synthetic UI fixture readable for this bounded test;
            # no upstream latest-tail request can validate these invented bars.
            with transaction() as db:
                db.get(ProviderDataset, key).latest_at = stamp + 3600000
    print("Synthetic native UI cache seeded; not supplier price/coverage verification")
elif sys.argv[1] == "replay-seed":
    from alerts.storage import ImportJob, transaction

    with transaction() as db:
        for index in range(31):
            if not db.get(ImportJob, "ux-complete-" + str(index)):
                db.add(
                    ImportJob(
                        id="ux-complete-" + str(index),
                        instrument_id="BTCUSDT",
                        start=index * 60000,
                        end=(index + 1) * 60000,
                        cursor=(index + 1) * 60000,
                        status="complete",
                        priority=10,
                    )
                )
        if not db.get(ImportJob, "ux-failed"):
            db.add(
                ImportJob(
                    id="ux-failed",
                    instrument_id="BTCUSDT",
                    start=0,
                    end=60000,
                    cursor=0,
                    status="failed",
                    priority=10,
                    next_at=4102444800000,
                    error="Synthetic acceptance failure; no supplier retry requested",
                )
            )
    print("Completed and deferred-failure task records seeded for replay UI")
else:
    raise ValueError("Unknown fixture operation")
