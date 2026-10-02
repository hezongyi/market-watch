"""Compare one-socket baseline warmup with full warmup using real provider reads.

Run with provider credentials/proxies in the environment. No cache or database
writes, no selector changes, two concurrent readers with pairs a second apart.
"""

import argparse
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from alerts import provider_chart, provider_transport


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    records = []
    metas = [
        {"source": "binance", "symbol": "BTCUSDT", "basis": "last", "calendar": "utc0", "precision": 2},
        {"source": "oanda", "symbol": "AUD_CAD", "basis": "bid", "calendar": "ny17", "precision": 5},
    ]
    try:
        for meta in metas:
            for mode in ("baseline-single-head", "full-pool-warmup"):
                provider_transport.close_clients()
                client = provider_transport.pooled_client(meta["source"])
                warmed = time.monotonic()
                if mode == "baseline-single-head":
                    client.head(provider_transport.ORIGINS[meta["source"]], timeout=4)
                else:
                    assert provider_transport.warm_connections(client, meta["source"])
                warm_ms = round((time.monotonic() - warmed) * 1000, 2)
                for repeat in range(2):
                    time.sleep(1)  # Separate the two pairs, including warmup traffic.
                    start = threading.Barrier(2)

                    def read(index):
                        timings = {}
                        token = provider_chart.TIMINGS.set(timings)
                        start.wait(timeout=3)
                        began = time.monotonic()
                        result = {"source": meta["source"], "mode": mode,
                                  "repeat": repeat, "reader": index, "warm_ms": warm_ms}
                        try:
                            page = provider_chart.native_page(
                                meta, "M1", 1784937600000 - index * 86400000, 200,
                                client=client, deadline=began + 4,
                            )
                            result["bars"] = len(page["bars"])
                        except Exception as error:
                            result["error_type"] = type(error).__name__
                        finally:
                            result["elapsed_ms"] = round((time.monotonic() - began) * 1000, 2)
                            result["timings_ms"] = timings
                            provider_chart.TIMINGS.reset(token)
                        return result

                    with ThreadPoolExecutor(max_workers=2) as workers:
                        pair = list(workers.map(read, (0, 1)))
                    records.extend(pair)
                    args.output.write_text(json.dumps({"records": records}, indent=2))
                    for record in pair:
                        print(json.dumps(record), flush=True)
        full = [row for row in records if row["mode"] == "full-pool-warmup"]
        assert all(row.get("bars") == 200 and not row.get("error_type") for row in records)
        assert all(not any("connect_tcp" in key or "start_tls" in key
                           for key in row["timings_ms"]) for row in full), "Warm concurrent reads must not establish new tunnels"
        args.output.write_text(json.dumps({"passed": True, "records": records}, indent=2))
    finally:
        provider_transport.close_clients()


if __name__ == "__main__":
    main()
