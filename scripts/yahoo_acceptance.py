"""Live candidate-only Yahoo acceptance. Never read production env or databases.

Run with an explicitly isolated ALERTS_DATABASE_URL, ALERTS_YAHOO_ENABLED=true
and the configured proxy. Evidence contains market values, never environment URLs.
"""

import json
import time
from pathlib import Path

from alerts import provider_cache, provider_chart, storage
from alerts.chart_api import DataQuery
from alerts.config import settings
from alerts.provider_service import yahoo_quote
from alerts.yahoo_catalog import chart_metadata, seed
from sqlalchemy import func, select


def main():
    from sqlalchemy.engine import make_url

    url = make_url(settings.database_url)
    if url.get_backend_name() != "postgresql" or url.database != "market_watch_yahoo_acceptance":
        raise RuntimeError("requires dedicated market_watch_yahoo_acceptance PostgreSQL database")
    # This explicitly named database is disposable acceptance state. Stop its
    # API/worker processes before running the cold benchmark.
    from sqlalchemy import delete

    with storage.transaction() as db:
        keys = select(storage.ProviderDataset.id).where(storage.ProviderDataset.source == "yahoo")
        db.execute(
            delete(storage.ProviderInterest).where(storage.ProviderInterest.dataset_id.in_(keys))
        )
        db.execute(delete(storage.ProviderBar).where(storage.ProviderBar.dataset_id.in_(keys)))
        db.execute(delete(storage.ProviderDataset).where(storage.ProviderDataset.source == "yahoo"))
        for entry in db.scalars(
            select(storage.MarketCatalog).where(storage.MarketCatalog.source == "yahoo")
        ):
            entry.metadata_json = {}
            entry.updated_at = 0
    seed()
    from alerts.provider_yahoo import stable_id

    evidence = {"sdk": "1.7.0", "samples": [], "isolation": {}, "source_limits": []}
    for symbol in ["AAPL", "SPY", "GC=F", "CL=F", "EURUSD=X", "^GSPC"]:
        started = time.monotonic()
        meta = chart_metadata(stable_id(symbol), deadline=started + 20)
        metadata_ms = (time.monotonic() - started) * 1000
        request = DataQuery(
            instrument=meta["id"], series_kind="provider", timeframe="M5", limit=100
        )
        cold = provider_chart.data(request)
        elapsed = (time.monotonic() - started) * 1000
        started = time.monotonic()
        hot = provider_chart.data(request)
        hot_elapsed = (time.monotonic() - started) * 1000
        assert len(cold["bars"]) == 100 and hot["bars"] == cold["bars"] and hot["cache_hit"]
        assert hot_elapsed < 1000
        quote = yahoo_quote(meta)
        assert quote["quote_time"] and quote["fetched_at"] and quote["price"]
        evidence["samples"].append(
            {
                "symbol": symbol,
                "cold_ms": round(elapsed, 2),
                "metadata_ms": round(metadata_ms, 2),
                "hot_ms": round(hot_elapsed, 2),
                "bars": len(cold["bars"]),
                "timings": cold["timings_ms"],
                "quote": quote,
            }
        )
        print(symbol, "cold", round(elapsed), "ms hot", round(hot_elapsed), "ms", flush=True)
    meta = chart_metadata(stable_id("CL=F"))
    before = int(storage.ms(storage.instant(0).replace(year=2020, month=4, day=24)))
    negative = provider_cache.read(meta, "D1", before, 8, deadline=time.monotonic() + 20)
    april20 = next(b for b in negative["bars"] if b["chart_time"] == 1587340800000)
    assert float(april20["close"]) < 0 and float(april20["low"]) < 0
    evidence["negative_oil"] = april20
    with storage.transaction() as db:
        evidence["isolation"] = {
            model.__tablename__: db.scalar(select(func.count()).select_from(model))
            for model in (
                storage.Bar,
                storage.ChartHistoryPlan,
                storage.ChartPublication,
                storage.ImportJob,
                storage.Watch,
                storage.Outbox,
            )
        }
        assert all(value == 0 for value in evidence["isolation"].values())
    Path("docs/verification/yahoo/postgres-live.json").write_text(
        json.dumps(evidence, ensure_ascii=False, indent=2) + "\n"
    )
    print("PostgreSQL + real proxy native data acceptance passed", flush=True)


if __name__ == "__main__":
    main()
