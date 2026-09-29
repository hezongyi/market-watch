"""Development-only authenticated export acceptance; credentials never enter CLI arguments.

Pass --start YYYY-MM-DDTHH:MM:SS+00:00 for an uncached trading hour.
Requires MARKET_WATCH_TEST_CREDENTIALS pointing to a JSON file with password.
"""

import argparse
import csv
import io
import json
import os
import time
from datetime import datetime
from pathlib import Path

import httpx


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start", required=True)
    parser.add_argument("--require-pending", action="store_true")
    args = parser.parse_args()
    start = datetime.fromisoformat(args.start)
    if start.tzinfo is None:
        parser.error("--start must include its UTC offset")
    left = int(start.timestamp() * 1000)
    secret = json.loads(Path(os.environ["MARKET_WATCH_TEST_CREDENTIALS"]).read_text())
    with httpx.Client(base_url="http://127.0.0.1:8001", timeout=30) as client:
        login = client.post("/api/login", json={"password": secret["password"]})
        login.raise_for_status()
        client.headers["X-CSRF-Token"] = login.json()["csrf"]
        body = {"instrument": "EURUSD", "timeframe": "M1", "start": left, "end": left + 3600000}
        seen_pending = False
        started = time.monotonic()
        for attempt in range(90):
            response = client.post("/api/charts/export", json=body)
            print(
                f"Attempt {attempt}: HTTP {response.status_code}, {time.monotonic() - started:.1f}s",
                flush=True,
            )
            if response.status_code == 202:
                seen_pending = True
                time.sleep(2)
                continue
            response.raise_for_status()
            assert response.headers["content-type"].startswith("text/csv")
            rows = list(csv.DictReader(io.StringIO(response.content.decode("utf-8-sig"))))
            assert not args.require_pending or seen_pending, "No cold-load pending state observed"
            assert [int(row["start_ms"]) for row in rows] == list(
                range(left, left + 3600000, 60000)
            )
            assert all(row["complete"] == "true" for row in rows)
            print("PASS: 60 ordered complete EURUSD M1 bars, exact requested interval")
            return
        raise TimeoutError("Export did not finish within acceptance budget")


if __name__ == "__main__":
    main()
