"""Actual provider + isolated PostgreSQL counts; never deletes runtime cache."""

import argparse
import json
import os
import random
import time
import uuid
from datetime import datetime
from pathlib import Path

from sqlalchemy import create_engine, delete, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--counts", default="200,400,600,1000,2000,4000")
    parser.add_argument("--output", default="/tmp/mw-provider-buffer-acquisition")
    args = parser.parse_args()
    counts = [int(n) for n in args.counts.split(",")]
    assert args.rounds > 0 and all(1 <= n <= 20000 for n in counts)
    config = dict(
        line.split("=", 1)
        for line in Path("/tmp/mw-dual-acceptance/api.env").read_text().splitlines()
        if "=" in line and not line.startswith("#")
    )
    for key, value in config.items():
        if key.startswith("ALERTS_"):
            os.environ[key] = value
    os.environ["ALERTS_DELIVERY_ENABLED"] = "false"
    url = make_url(config["ALERTS_DATABASE_URL"])
    assert url.host == "market-watch-postgres-isolated" and url.database == "market_watch_dual"
    url = url.set(host="127.0.0.1", port=15432, database="market_watch_isolated")
    from alerts import provider_cache as cache
    from alerts import provider_chart as upstream
    from alerts import storage
    from alerts.config import settings
    from alerts.provider_transport import close_clients

    settings.provider_request_seconds = 20
    schema = "buffer_" + uuid.uuid4().hex
    admin = create_engine(url, pool_size=1, max_overflow=0)
    with admin.begin() as conn:
        conn.execute(text(f"CREATE SCHEMA {schema}"))
    engine = create_engine(
        url, connect_args={"options": f"-csearch_path={schema}"}, pool_size=1, max_overflow=0
    )
    storage.Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    storage.Session = factory
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    result = {
        "kind": "cold provider cache in unique PostgreSQL test schema; running warmed provider connections; no runtime cache deletion",
        "counts": counts,
        "records": [],
    }
    metas = [
        {
            "id": "OANDA:AUD_CAD",
            "symbol": "AUD_CAD",
            "source": "oanda",
            "basis": "bid",
            "calendar": "ny17",
            "precision": 5,
        },
        {
            "id": "BTCUSDT",
            "symbol": "BTCUSDT",
            "source": "binance",
            "basis": "last",
            "calendar": "utc0",
            "precision": 2,
        },
    ]
    anchor = int(datetime.fromisoformat("2026-09-09T14:00:00+00:00").timestamp() * 1000)
    original = upstream.native_page
    calls = []

    def tracked(*args, **kw):
        calls.append({"count": args[3], "before": args[2]})
        return original(*args, **kw)

    upstream.native_page = tracked
    try:
        # Transport warm-up is outside measured cold-cache trials.
        for meta in metas:
            try:
                original(meta, "M5", anchor, 1, deadline=time.monotonic() + 15)
            except Exception as e:
                print("warmup", meta["source"], type(e).__name__, flush=True)
        for repeat in range(args.rounds):
            pairs = [(meta, n) for meta in metas for n in result["counts"]]
            random.Random(4200 + repeat).shuffle(pairs)
            for meta, n in pairs:
                with factory.begin() as db:
                    db.execute(delete(storage.ProviderBar))
                    db.execute(delete(storage.ProviderDataset))
                calls.clear()
                began = time.monotonic()
                row = {
                    "repeat": repeat,
                    "source": meta["source"],
                    "frame": "M5",
                    "count": n,
                    "before": anchor,
                }
                try:
                    page = cache.read(meta, "M5", anchor, n, deadline=time.monotonic() + 20)
                    row.update(
                        elapsed_ms=round((time.monotonic() - began) * 1000, 2),
                        returned=len(page["bars"]),
                        cache_hit=page["cache_hit"],
                        timings_ms=page["timings_ms"],
                        upstream_pages=list(calls),
                    )
                    serialization = time.monotonic()
                    payload = json.dumps(page, separators=(",", ":")).encode()
                    row["serialize_ms"] = round((time.monotonic() - serialization) * 1000, 2)
                    row["response_bytes"] = len(payload)
                    row["warm_reads"] = []
                    for _ in range(3):
                        began_warm = time.monotonic()
                        warm = cache.read(meta, "M5", anchor, n)
                        row["warm_reads"].append(
                            {
                                "elapsed_ms": round((time.monotonic() - began_warm) * 1000, 2),
                                "cache_hit": warm["cache_hit"],
                                "returned": len(warm["bars"]),
                            }
                        )
                except Exception as e:
                    row.update(
                        elapsed_ms=round((time.monotonic() - began) * 1000, 2),
                        error_type=type(e).__name__,
                        upstream_pages=list(calls),
                    )
                result["records"].append(row)
                (out / "results.json").write_text(json.dumps(result, indent=2))
                print(
                    json.dumps({k: v for k, v in row.items() if k not in ["warm_reads", "before"]}),
                    flush=True,
                )
    finally:
        close_clients()
        engine.dispose()
        with admin.begin() as conn:
            conn.execute(text(f"DROP SCHEMA {schema} CASCADE"))
        admin.dispose()
        result["test_schema_removed"] = True
        (out / "results.json").write_text(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
