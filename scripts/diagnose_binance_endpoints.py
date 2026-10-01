"""Read-only official Binance endpoint comparison with fresh/reused HTTP clients."""

import argparse
import json
import time
from pathlib import Path

import httpx


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--rounds", type=int, default=4)
    args = parser.parse_args()
    origins = ["https://data-api.binance.vision", "https://api.binance.com",
               "https://api1.binance.com", "https://api4.binance.com"]
    params = {"symbol": "BTCUSDT", "interval": "1m", "limit": 200,
              "endTime": int(time.time() * 1000)}
    records = []
    for turn in range(args.rounds):
        for origin in origins if turn % 2 == 0 else reversed(origins):
            with httpx.Client(proxy="http://192.168.7.33:7890", trust_env=False,
                              timeout=4, limits=httpx.Limits(max_connections=1,
                              max_keepalive_connections=1)) as client:
                for repeat in range(2):
                    phases, started_phases = {}, {}
                    def trace(name, info):
                        stage, _, event = name.rpartition(".")
                        if event == "started":
                            started_phases[stage] = time.monotonic()
                        elif event in ("complete", "failed") and stage in started_phases:
                            phases[stage] = round((time.monotonic() - started_phases.pop(stage)) * 1000, 2)
                    began = time.monotonic()
                    record = {"round": turn, "origin": origin, "repeat": repeat,
                              "phases_ms": phases}
                    try:
                        response = client.get(origin + "/api/v3/klines", params=params,
                                              extensions={"trace": trace})
                        record["status"] = response.status_code
                        if response.status_code == 200:
                            record["bars"] = len(response.json())
                    except httpx.HTTPError as error:
                        record["error_type"] = type(error).__name__
                    record["elapsed_ms"] = round((time.monotonic() - began) * 1000, 2)
                    record["new_connection"] = any("connect_tcp" in key for key in phases)
                    records.append(record)
                    Path(args.output).write_text(json.dumps({"records": records}, indent=2))
                    print(json.dumps(record), flush=True)


if __name__ == "__main__":
    main()
