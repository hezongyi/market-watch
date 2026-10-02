"""Inject/restore one cached historical revision in the local acceptance DB only."""

import argparse
import json
import os
import time
from decimal import Decimal
from pathlib import Path

from sqlalchemy import create_engine, select
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("revise", "restore", "snapshot"))
    parser.add_argument("--native-history", action="store_true")
    parser.add_argument("--offset", type=int, default=20)
    parser.add_argument("--marker", required=True)
    args = parser.parse_args()
    assert 0 <= args.offset <= 20000
    marker = Path(args.marker)
    assert marker.parent == Path("/tmp") and marker.name.startswith("mw-provider-revision-")
    config = dict(
        line.split("=", 1)
        for line in Path("/tmp/mw-native-history/api.env" if args.native_history
                         else "/tmp/mw-dual-acceptance/api.env").read_text().splitlines()
        if "=" in line and not line.startswith("#")
    )
    url = make_url(config["ALERTS_DATABASE_URL"])
    if args.native_history:
        assert url.host == "market-watch-native-history-pg" and url.database == "market_watch_native_history"
    else:
        assert url.host == "market-watch-postgres-isolated" and url.database == "market_watch_dual"
    os.environ["ALERTS_DATABASE_URL"] = url.set(host="127.0.0.1", port=15532 if args.native_history else 15432).render_as_string(hide_password=False)
    from alerts.storage import ProviderBar, ProviderDataset, now_ms

    engine = create_engine(os.environ["ALERTS_DATABASE_URL"], pool_size=1, max_overflow=0)
    factory = sessionmaker(engine)
    try:
        if args.action == "snapshot":
            with factory.begin() as db:
                dataset = db.scalar(select(ProviderDataset).where(
                    ProviderDataset.symbol == "BTCUSDT", ProviderDataset.timeframe == "M5"
                ))
                assert dataset is not None
                print(json.dumps({"id": dataset.id, "coverage": dataset.coverage,
                                  "revision": dataset.revision}))
        elif args.action == "revise":
            assert not marker.exists(), "restore the previous injection first"
            deadline = time.monotonic() + 35
            while True:
                with factory.begin() as db:
                    dataset = db.scalar(select(ProviderDataset).where(
                        ProviderDataset.symbol == "BTCUSDT", ProviderDataset.timeframe == "M5"
                    ).with_for_update())
                    assert dataset is not None
                    if dataset.lease_until <= now_ms():
                        row = db.scalar(select(ProviderBar).where(
                            ProviderBar.dataset_id == dataset.id, ProviderBar.complete.is_(True)
                        ).order_by(ProviderBar.chart_time.desc()).offset(args.offset).limit(1))
                        assert row is not None
                        saved = {"dataset_id": dataset.id, "start": row.start, "payload": row.payload}
                        marker.write_text(json.dumps(saved))
                        changed = dict(row.payload)
                        # Preserve OHLC ordering; the test only changes isolated cache data.
                        for field in ("open", "high", "low", "close"):
                            changed[field] = str(Decimal(changed[field]) + Decimal("0.01"))
                        row.payload = changed
                        row.revision += 1
                        row.observed_at = row.changed_at = now_ms()
                        dataset.revision += 1
                        dataset.updated_at = row.changed_at
                        print(json.dumps({"action": "revise", "start": row.start,
                                          "close": changed["close"], "revision": dataset.revision}))
                        break
                if time.monotonic() >= deadline:
                    raise TimeoutError("provider acquisition did not release its lease")
                time.sleep(0.1)
        else:
            saved = json.loads(marker.read_text())
            with factory.begin() as db:
                dataset = db.get(ProviderDataset, saved["dataset_id"], with_for_update=True)
                assert dataset.symbol == "BTCUSDT" and dataset.timeframe == "M5"
                row = db.get(ProviderBar, (dataset.id, saved["start"]))
                row.payload = saved["payload"]
                row.revision += 1
                row.observed_at = row.changed_at = now_ms()
                dataset.revision += 1
                dataset.updated_at = row.changed_at
            marker.unlink()
            print(json.dumps({"action": "restore", "start": saved["start"]}))
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
