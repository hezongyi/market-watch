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
        if not db.get(MarketCatalog, "UX:OANDA:EUR_USD"):
            db.add(MarketCatalog(id="UX:OANDA:EUR_USD", source="oanda", symbol="EUR_USD",
                label="Synthetic OANDA catalog scope", asset_type="CURRENCY", calendar="ny17", precision=5,
                metadata_json={"history_account_scope":"sha256:" + "a" * 64}))
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
    from alerts.provider_chart import metadata
    from alerts.provider_dukascopy import stable_id
    from alerts.storage import ProviderDataset, now_ms, transaction

    # Explicitly synthetic cache for native UI/axis behavior, never evidence of
    # supplier availability or prices. Only this task's database is reachable.
    stamp = now_ms()
    for symbol, price in (("EUR/USD", 1.12), ("AAPL.US/USD", 320), ("BTCUSDT", 84000)):
        meta = metadata("BTCUSDT" if symbol == "BTCUSDT" else stable_id(symbol))
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
elif sys.argv[1] == "fixed-seed":
    import json
    from decimal import Decimal

    from alerts import history_versions as history
    from alerts.history_artifacts import artifact_tick, request_artifacts
    from alerts.market_contracts import CandleBatch, DatasetIdentity, MinuteRow, RequestResult
    from alerts.storage import AdvancedWorkspace, HistoryVersion, MarketDataset, transaction
    from sqlalchemy import select

    # Generate synthetic minutes through the real importer/publisher. Do not
    # invent a published manifest or bypass fixed-version/period invariants.
    with transaction() as db:
        dataset = db.scalar(select(MarketDataset).where(MarketDataset.logical_symbol == "EURUSD"))
        identity = DatasetIdentity.model_validate(dataset.identity)
        instrument = dataset.instrument_id
        start, end = 1791158400000, 1791417600000  # Oct 5--8, 2026 UTC
        version = history.create_version(db, dataset.id, start, end)

    class SyntheticAdapter:
        def page(self, identity, start, end):
            rows = []
            for index, at in enumerate(range(start, end, 60000)):
                price = Decimal("1.12000") + Decimal(index % 100) / Decimal("100000")
                rows.append(MinuteRow(timestamp=at, open=str(price), high=str(price + Decimal("0.00020")),
                    low=str(price - Decimal("0.00020")), close=str(price + Decimal("0.00010")),
                    volume="10", complete=True))
            return CandleBatch(identity=identity, window_start=start, window_end=end, observed_at=end + 60000,
                result=RequestResult(status="data"), rows=tuple(rows), checkpoint=end,
                volume_kind="price_count", volume_unit="quotes")

    for _ in range(100):
        history.import_page(SyntheticAdapter(), version_id=version)
        with transaction() as db:
            row = db.get(HistoryVersion, version)
            if row.status == "published":
                break
            if row.error:
                raise RuntimeError("Synthetic import failed: " + row.error)
    with transaction() as db:
        row = db.get(HistoryVersion, version)
        if row.status != "published":
            raise RuntimeError("Synthetic version failed to publish: " + str(row.error))
        request_artifacts(db, row, ["M1", "H4", "D1"])
        native = db.get(AdvancedWorkspace, "ux-synthetic-native")
        native.document = {"engine": "tv31", "schemaVersion": 1, "symbol": "MWP:BTCUSDT", "series_kind": "provider"}
    while artifact_tick(version):
        pass
    print(json.dumps({"version_id": version, "instrument_id": instrument, "start": start, "end": end,
        "scope": "synthetic isolated imported/published minutes, not upstream verification"}))
elif sys.argv[1] == "composite-seed":
    import json

    from alerts.composite_definitions import first_use, save_mapping
    from alerts.history_catalog import account_scope
    from alerts.storage import MarketCatalog, MarketDataset, transaction
    from sqlalchemy import select

    # Only this short-lived fixture process has a synthetic marker; no provider
    # reads are made and no usable token is written to the application config.
    settings.oanda_token = "synthetic-no-provider-access"
    try:
        with transaction() as db:
            dataset = db.scalar(select(MarketDataset).where(MarketDataset.logical_symbol == "EURUSD"))
            catalog_id = "HC:" + "f" * 36
            if not db.get(MarketCatalog, catalog_id):
                db.add(MarketCatalog(id=catalog_id, source="oanda", symbol="EUR_USD", label="Synthetic composite target",
                    asset_type="CURRENCY", precision=5, calendar="ny17",
                    metadata_json={"history_account_scope":account_scope()}))
                db.flush()
            mapping = save_mapping(db, dataset.id, catalog_id, {
                "underlying":"EUR", "quote_currency":"USD", "historical_product":"spot_fx", "live_product":"spot_fx",
                "relationship":"same_product", "historical_evidence":"https://example.invalid/synthetic-history",
                "live_evidence":"https://example.invalid/synthetic-live", "reviewed":True,
                "rationale":"Synthetic UI fixture only; this does not verify actual supplier equivalence"})
            composite = first_use(db, dataset.id, mapping.id)
            print(json.dumps({"composite_id":composite.id,"revision_id":composite.active_revision_id,
                "scope":"Synthetic isolated mapping/first-use; no upstream pricing or product-equivalence claim"}))
    finally:
        settings.oanda_token = ""
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
