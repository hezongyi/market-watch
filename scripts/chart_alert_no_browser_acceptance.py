"""Real provider acquisition after all browser interests expire in task-owned DB.

The API's deployed provider/alert loops perform all fetching and evaluation.
This script only queries evidence and adds a non-triggering rule to that cached
real-source dataset. No market-data rows or timestamps are manufactured.
"""

import argparse
import json
import time
import uuid
from pathlib import Path

from alerts.chart_alert_service import AlertConfig, create
from alerts.storage import ChartAlert, ProviderBar, ProviderDataset, ProviderInterest
from sqlalchemy import create_engine, func, select
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker

ROOT = Path("/tmp/mw-chart-alerts-acceptance")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database-host", required=True)
    args = parser.parse_args()
    values = dict(
        line.split("=", 1) for line in (ROOT / "api.env").read_text().splitlines() if "=" in line
    )
    url = make_url(values["ALERTS_DATABASE_URL"]).set(host=args.database_host)
    if url.database != "chart_alerts_acceptance" or url.username != "chart_alerts_acceptance":
        raise ValueError("Only task-owned database allowed")
    engine = create_engine(url)
    factory = sessionmaker(engine, expire_on_commit=False)
    with factory.begin() as db:
        dataset = db.scalar(
            select(ProviderDataset).where(
                ProviderDataset.symbol == "BTCUSDT",
                ProviderDataset.timeframe == "M1",
                ProviderDataset.latest_at > 0,
            )
        )
        if dataset is None:
            raise ValueError("No real cached Binance M1 dataset")
        config = AlertConfig(
            name="Real source without browser",
            instrument=dataset.metadata_json["id"],
            series_kind="provider",
            source="binance",
            timeframe="M1",
            mode="intrabar",
            max_triggers=3,
            condition={
                "relation": "cross_up",
                "left": {"kind": "price"},
                "right": {"kind": "constant", "value": "1000000"},
            },
        )
        row = create(db, "no-browser-" + uuid.uuid4().hex, config, dataset_id=dataset.id)
        ident, key = row.id, dataset.id
    until = time.monotonic() + 900
    start = None
    report = {
        "scope": "deployed API alert/provider loops and real Binance; zero live browser interests"
    }
    try:
        while time.monotonic() < until:
            now = int(time.time() * 1000)
            if int(time.monotonic()) % 20 == 0:
                print("Waiting for browser interest expiry and real provider progress", flush=True)
            with factory() as db:
                live = db.scalar(
                    select(func.count())
                    .select_from(ProviderInterest)
                    .where(ProviderInterest.expires > now)
                )
                dataset = db.get(ProviderDataset, key)
                row = db.get(ChartAlert, ident)
                evidence = {
                    "provider_latest_at": dataset.latest_at,
                    "checkpoint": row.state.get("sequence", -1),
                    "health": row.health,
                    "count": row.count,
                    "live_browser_interests": live,
                    "cached_bars": db.scalar(
                        select(func.count())
                        .select_from(ProviderBar)
                        .where(ProviderBar.dataset_id == key)
                    ),
                }
            if live == 0 and evidence["health"] == "ready":
                if start is None:
                    start = evidence
                elif (
                    evidence["provider_latest_at"] > start["provider_latest_at"]
                    and evidence["checkpoint"] > start["checkpoint"]
                ):
                    report.update(
                        {"verified": True, "alert_id": ident, "before": start, "after": evidence}
                    )
                    (ROOT / "no-browser-real-source.json").write_text(
                        json.dumps(report, indent=2) + "\n"
                    )
                    print(json.dumps(report))
                    return
            else:
                start = None
            time.sleep(1)
        raise AssertionError(
            "Real source acquisition/checkpoint failed to progress without browser interests"
        )
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
