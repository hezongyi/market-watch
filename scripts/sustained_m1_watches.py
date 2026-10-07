"""Idempotent local M1 evaluation rules for this Ubuntu acceptance window."""

import argparse
import json
import time
from decimal import Decimal
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
PREFIX = "Ubuntu sustained M1 acceptance "


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("ensure", "status", "cancel"))
    args = parser.parse_args()
    with httpx.Client(base_url="http://127.0.0.1:16589", timeout=30, trust_env=False) as client:
        login = client.post("/api/login", json=json.loads(
            (ROOT / "artifacts/data-integration/login.json").read_text()))
        login.raise_for_status()
        client.headers["X-CSRF-Token"] = login.json()["csrf"]

        def request(path, body=None):
            response = client.get(path) if body is None else client.post(path, json=body)
            response.raise_for_status()
            return response.json()

        watches = request("/api/watches")
        owned = [watch for watch in watches if watch["name"].startswith(PREFIX)]
        if args.command == "cancel":
            for watch in owned:
                if watch["status"] == "active":
                    request("/api/watches/" + watch["id"] + "/cancel", {})
        elif args.command == "ensure":
            for live in request("/api/market-data/live"):
                if live["logical_symbol"] not in ("EURUSD", "XAUUSD"):
                    continue
                if not live["candle_ready"] or not live["quote"]:
                    raise RuntimeError("Resident source must have confirmed M1 and a quote")
                if any(watch["status"] == "active" and watch["instrument_id"] == live["instrument_id"]
                       for watch in owned):
                    continue
                # This remote threshold keeps computation active without trying
                # to force a signal. External delivery is disabled by Compose.
                request("/api/watches", {"instrument_id": live["instrument_id"],
                    "name": PREFIX + live["logical_symbol"], "kind": "price", "timeframe": "M1",
                    "direction": "buy", "level": str(Decimal(live["quote"]["bid"]) * 1000),
                    "touch": False, "use_history": False})
        watches = [watch for watch in request("/api/watches") if watch["name"].startswith(PREFIX)]
        signals = request("/api/signals")
        result = {"host": "Ubuntu isolated Docker", "observed_at": int(time.time() * 1000),
            "command": args.command, "external_delivery": "disabled by acceptance Compose",
            "watches": [{key: watch[key] for key in ("id", "instrument_id", "name", "status", "armed_at",
                                                      "paused_reason", "state")} for watch in watches],
            "signal_counts": {watch["id"]: sum(s["watch_id"] == watch["id"] for s in signals)
                              for watch in watches}}
        print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
