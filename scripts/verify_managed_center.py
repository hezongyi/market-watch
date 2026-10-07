"""Actual isolated HTTP and supplier checks; credentials stay in ignored files."""

import argparse
import json
import time
from pathlib import Path

import httpx


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:16629")
    parser.add_argument("--login", type=Path, default=Path("artifacts/data-integration/three-layer-login.json"))
    parser.add_argument("--output", type=Path, default=Path("artifacts/data-integration/managed-real-sources.json"))
    args = parser.parse_args()
    records = []
    with httpx.Client(base_url=args.base, timeout=30, trust_env=False) as client:
        ready_deadline = time.monotonic() + 60
        while time.monotonic() < ready_deadline:
            try:
                if client.get("/readyz", timeout=5).is_success:
                    break
            except httpx.TransportError:
                pass
            time.sleep(1)
        else:
            raise RuntimeError("isolated API did not become ready within 60 seconds")
        login = client.post("/api/login", json=json.loads(args.login.read_text()))
        login.raise_for_status()
        client.headers["X-CSRF-Token"] = login.json()["csrf"]
        def get(path):
            r = client.get("/api/market-data/" + path)
            r.raise_for_status()
            return r.json()
        def post(path, body):
            r = client.post("/api/market-data/" + path, json=body)
            r.raise_for_status()
            return r.json()
        for source, symbol, provider, asset, precision in (
            ("dukascopy", "XAUUSD", "XAU/USD", "metal", 3),
            ("oanda", "EURUSD", "EUR_USD", "forex", 5),
            ("oanda", "XAUUSD", "XAU_USD", "metal", 3),
        ):
            start = get("date-boundary?date=2026-10-05&calendar=ny17")["start"]
            body = {"request_id": f"real-multi-source-{source}-{symbol}",
                "dataset": {"source": source, "logical_symbol": symbol, "provider_symbol": provider,
                    "asset_class": asset, "precision": precision, "aggregation_calendar": "ny17"},
                "maintenance": {"target_start": start, "timeframes": ["M1", "H4", "D1"], "frequency": "once"}}
            created = post("center/datasets", body)
            repeated = post("center/datasets", body)
            assert created["task"]["id"] == repeated["task"]["id"]
            ident = created["dataset"]["id"]
            deadline = time.monotonic() + 180
            while time.monotonic() < deadline:
                report = get("center/datasets/" + ident)
                version = report["latest_version_id"]
                ready = {p["timeframe"] for p in report["periods"]
                         if p["status"] == "published" and p.get("available_version_id") == version}
                if all(frame in ready for frame in ("M1", "H4", "D1")):
                    break
                if report["maintenance"].get("task_error"):
                    print(json.dumps({"source": source, "symbol": symbol,
                        "status": report["maintenance"].get("task_status"),
                        "error": report["maintenance"].get("task_error")}), flush=True)
                time.sleep(3)
            else:
                raise RuntimeError(f"{source}/{symbol}: no period publication within 180 seconds")
            version = report["latest_version_id"]
            bars = get(f"versions/{version}/bars?timeframe=M1&limit=20000")["bars"]
            assert bars and all(b["parent_version_id"] == version and b["source_confirmed"] for b in bars)
            period_rows = {"M1": len(bars)}
            for frame in ("H4", "D1"):
                derived = get(f"versions/{version}/bars?timeframe={frame}&limit=20000")["bars"]
                assert derived and all(b["parent_version_id"] == version for b in derived)
                period_rows[frame] = len(derived)
            record = {"source": source, "symbol": symbol, "dataset_id": ident, "version_id": version,
                "rows": len(bars), "unknown_minutes": report["unknown_minutes"],
                "timeframes": report["usable_timeframes"], "period_rows": period_rows, "passed": True}
            records.append(record)
            print(json.dumps({"source": source, "symbol": symbol, "rows": len(bars), "passed": True}), flush=True)
    args.output.write_text(json.dumps({"environment": "Ubuntu isolated market-watch-three-layer",
        "base": args.base, "scope": "real original supplier M1 and independent period publication",
        "records": records, "passed": True}, indent=2) + "\n")


if __name__ == "__main__":
    main()
