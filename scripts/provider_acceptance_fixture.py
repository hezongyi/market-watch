"""Reset/snapshot only explicitly named local acceptance caches, never managed data."""

import argparse
import json
import os
import time
from pathlib import Path

from sqlalchemy import create_engine, delete, func, select, update
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--reset", action="store_true")
    parser.add_argument("--profile", choices=["dual", "provider-fix"], default="dual")
    parser.add_argument("--output")
    parser.add_argument("--instrument", default="OANDA:AUD_CAD")
    parser.add_argument("--client", help="Inspect only this local acceptance client's finite targets")
    parser.add_argument("--expire-client", action="store_true")
    args = parser.parse_args()
    env_path, database, host = {
        "dual": ("/tmp/mw-dual-acceptance/api.env", "market_watch_dual", "market-watch-postgres-isolated"),
        "provider-fix": ("/tmp/mw-provider-latency/api.env", "market_watch_provider_fix", "127.0.0.1"),
    }[args.profile]
    config = dict(
        line.split("=", 1)
        for line in Path(env_path).read_text().splitlines()
        if "=" in line and not line.startswith("#")
    )
    url = make_url(config["ALERTS_DATABASE_URL"])
    assert url.host == host and url.database == database and (url.port or 5432) == (15432 if args.profile == "provider-fix" else 5432)
    os.environ["ALERTS_DATABASE_URL"] = url.set(host="127.0.0.1", port=15432).render_as_string(
        hide_password=False
    )
    os.environ["ALERTS_DELIVERY_ENABLED"] = "false"
    from alerts.storage import (
        Bar,
        ChartHistoryPlan,
        ImportJob,
        ProviderBar,
        ProviderDataset,
        ProviderInterest,
        now_ms,
    )

    engine = create_engine(os.environ["ALERTS_DATABASE_URL"], pool_size=1, max_overflow=0)
    factory = sessionmaker(engine)
    if args.expire_client:
        assert args.client and args.client.startswith("acceptance-history-"), "only expire a named acceptance client"
        with factory.begin() as db:
            db.execute(update(ProviderInterest).where(ProviderInterest.client == args.client).values(expires=now_ms()-1))
    if args.reset:
        with factory.begin() as db:
            db.execute(delete(ProviderInterest))
        deadline = time.monotonic() + 35
        while True:
            with factory.begin() as db:
                busy = db.scalar(
                    select(func.count())
                    .select_from(ProviderDataset)
                    .where(ProviderDataset.lease_until > now_ms())
                )
            if not busy:
                break
            if time.monotonic() > deadline:
                raise TimeoutError("In-flight provider work did not finish")
            time.sleep(0.1)
        with factory.begin() as db:
            assert db.scalar(select(func.count()).select_from(ProviderInterest)) == 0, (
                "close the chart before resetting the fixture"
            )
            db.execute(delete(ProviderBar))
            db.execute(delete(ProviderDataset))
    with factory.begin() as db:
        datasets = []
        for row in db.scalars(
            select(ProviderDataset).order_by(
                ProviderDataset.source, ProviderDataset.symbol, ProviderDataset.timeframe
            )
        ):
            count = db.scalar(
                select(func.count())
                .select_from(ProviderBar)
                .where(ProviderBar.dataset_id == row.id)
            )
            datasets.append(
                {
                    "source": row.source,
                    "symbol": row.symbol,
                    "frame": row.timeframe,
                    "count": count,
                    "earliest": row.earliest,
                    "coverage": row.coverage,
                    "latest_at": row.latest_at,
                    "revision": row.revision,
                }
            )
        result = {
            "at": now_ms(),
            "reset": args.reset,
            "datasets": datasets,
            "interest_count": db.scalar(select(func.count()).select_from(ProviderInterest)),
            "subscriptions": db.scalar(
                select(func.count())
                .select_from(ProviderInterest)
                .where(ProviderInterest.subscribed.is_(True))
            ),
            "managed_bars": db.scalar(select(func.count()).select_from(Bar)),
            "test_symbol": args.instrument,
            "test_symbol_managed_bars": db.scalar(select(func.count()).select_from(Bar).where(Bar.instrument_id == args.instrument)),
            "test_symbol_managed_jobs": db.scalar(select(func.count()).select_from(ImportJob).where(ImportJob.instrument_id == args.instrument)),
            "test_symbol_managed_plans": [
                {"instrument": row.instrument_id, "target_start": row.target_start, "realtime_enabled": row.realtime_enabled}
                for row in db.scalars(select(ChartHistoryPlan).where(ChartHistoryPlan.instrument_id == args.instrument))
            ],
        }
        if args.client:
            result["interests"] = []
            for interest in db.scalars(select(ProviderInterest).where(ProviderInterest.client == args.client)):
                focus = db.get(ProviderDataset, interest.dataset_id)
                targets = []
                for target in interest.targets:
                    dataset = db.scalar(select(ProviderDataset).where(
                        ProviderDataset.source == focus.source,
                        ProviderDataset.symbol == focus.symbol,
                        ProviderDataset.timeframe == target["frame"],
                    ))
                    stats = {**target, "actual": 0, "connected": False}
                    if dataset:
                        conditions = [ProviderBar.dataset_id == dataset.id,
                                      ProviderBar.chart_time < target["before"]]
                        if "after" in target:
                            conditions.append(ProviderBar.chart_time >= target["after"])
                        stats["actual"] = db.scalar(select(func.count()).select_from(ProviderBar).where(*conditions))
                        stats["earliest"] = dataset.earliest
                        stats["connected"] = any(
                            start <= target.get("after", target["before"] - 1) and target["before"] <= end
                            for start, end in dataset.coverage
                        )
                    targets.append(stats)
                result["interests"].append({"id": interest.id, "listener": interest.listener,
                    "cursor": interest.cursor, "expires": interest.expires,
                    "subscribed": interest.subscribed, "targets": targets})
    engine.dispose()
    if args.output:
        Path(args.output).write_text(json.dumps(result, indent=2))
    print(json.dumps(result))


if __name__ == "__main__":
    main()
