"""Renew ten browser demands; observe one real shared stream alongside history."""

import json
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
SYMBOLS = ("EURUSD", "XAUUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF",
           "NZDUSD", "EURGBP", "EURJPY")


def main():
    result = {"host": "Ubuntu local Docker", "project": "market-watch-data-integration",
              "symbols": SYMBOLS, "history_worker_running": True, "started_at": int(time.time() * 1000),
              "samples": [], "passed": False}
    with httpx.Client(base_url="http://127.0.0.1:16589", timeout=15, trust_env=False) as client:
        login = client.post("/api/login", json=json.loads((ROOT / "artifacts/data-integration/login.json")
                            .read_text()))
        login.raise_for_status()
        client.headers["X-CSRF-Token"] = login.json()["csrf"]
        catalog = client.get("/api/market-data/datasets")
        catalog.raise_for_status()
        datasets = {row["logical_symbol"]: row["id"] for row in catalog.json()
                    if row["identity"]["source"] == "oanda"}
        if any(symbol not in datasets for symbol in SYMBOLS):
            raise RuntimeError("The real account catalog must contain all ten test symbols")
        renewed = 0

        def renew():
            nonlocal renewed
            if time.monotonic() - renewed < 30:
                return
            for symbol in SYMBOLS:
                response = client.post("/api/market-data/live/demand",
                    json={"client": "ten-symbol-acceptance", "dataset_id": datasets[symbol]})
                response.raise_for_status()
            renewed = time.monotonic()

        def states():
            response = client.get("/api/market-data/live")
            response.raise_for_status()
            return {row["logical_symbol"]: row for row in response.json()}

        try:
            deadline = time.monotonic() + 150
            while time.monotonic() < deadline:
                renew()
                rows = states()
                if all(symbol in rows and rows[symbol]["candle_ready"] and rows[symbol]["quote_ready"]
                       for symbol in SYMBOLS):
                    break
                time.sleep(2)
            else:
                raise RuntimeError("All ten real instruments did not become ready within 150 seconds")
            epochs = {rows[symbol]["connection_epoch"] for symbol in SYMBOLS}
            if len(epochs) != 1:
                raise RuntimeError("Ten subscriptions are not on the same shared connection epoch")
            result["epoch"] = epochs.pop()
            # Begin at the next full minute, excluding this load's recovery warmup.
            since = (int(time.time() * 1000) // 60000 + 1) * 60000
            result["measurement_since"] = since
            end = since + 5 * 60000 + 35000
            while int(time.time() * 1000) < end:
                renew()
                rows = states()
                summary = [{"symbol": symbol, "quality": rows[symbol]["quality"],
                            "quote_ready": rows[symbol]["quote_ready"],
                            "candle_ready": rows[symbol]["candle_ready"],
                            "epoch": rows[symbol]["connection_epoch"]} for symbol in SYMBOLS]
                if any(row["epoch"] != result["epoch"] for row in summary):
                    raise RuntimeError("The shared stream changed epoch under stable ten-symbol load")
                result["samples"].append({"at": int(time.time() * 1000), "live": summary})
                print(json.dumps({"observed_at": result["samples"][-1]["at"],
                                  "healthy": sum(row["quality"] == "healthy" for row in summary),
                                  "epoch": result["epoch"]}), flush=True)
                time.sleep(10)
            result["metrics"] = []
            for symbol in SYMBOLS:
                response = client.get(f"/api/market-data/live/metrics/{datasets[symbol]}",
                                      params={"since": since})
                response.raise_for_status()
                result["metrics"].append({"symbol": symbol, **response.json()})
            # Current still-open/guard-window minutes are reported by metrics,
            # so candidate targets apply to completed samples and missing stays explicit.
            result["passed"] = all(row["confirmed"] >= 5 and row["p95_ms"] <= 15000
                                   and row["p99_ms"] <= 30000 and row["late_over_30s"] == 0
                                   and row["failed_attempts"] == 0 and row["missing"] == 0
                                   for row in result["metrics"])
            if not result["passed"]:
                raise RuntimeError("Ten-symbol live M1 timing/coverage target was not met")
        except Exception as error:
            result["error_type"] = type(error).__name__
            result["error"] = str(error)
            raise
        finally:
            # No demands are renewed after exit; only this test's subscriptions
            # expire naturally after 120 seconds. Resident EURUSD/XAUUSD remain.
            result["finished_at"] = int(time.time() * 1000)
            (ROOT / "docs/verification/data-integration/load-ten-symbols.json").write_text(
                json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
