"""Bounded interruption of only this Ubuntu Compose project's collector."""

import argparse
import json
import shlex
import subprocess
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
COMPOSE = ["docker", "compose", "--env-file", "artifacts/data-integration/compose.env",
           "-p", "market-watch-data-integration", "-f", "docs/verification/data-integration/compose.yaml"]


def docker(*arguments):
    subprocess.run(["sg", "docker", "-c", shlex.join(COMPOSE + list(arguments))], cwd=ROOT,
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=45)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--duration", type=int, choices=(30, 120), default=30)
    parser.add_argument("--restart", action="store_true")
    args = parser.parse_args()
    with httpx.Client(base_url="http://127.0.0.1:16589", timeout=10, trust_env=False) as client:
        credential = json.loads((ROOT / "artifacts/data-integration/login.json").read_text())
        client.post("/api/login", json=credential).raise_for_status()

        def snapshots():
            response = client.get("/api/market-data/live")
            response.raise_for_status()
            return response.json()

        before = snapshots()
        if not before or any(row["quality"] != "healthy" for row in before):
            raise RuntimeError("The collector must be healthy before fault injection")
        result = {"fault": "worker_restart" if args.restart else "worker_pause",
                  "duration_seconds": 0 if args.restart else args.duration,
                  "started_at": int(time.time() * 1000),
                  "before": [{"symbol": row["logical_symbol"], "epoch": row["connection_epoch"],
                              "confirmed_end": row["last_confirmed_m1"]} for row in before]}
        paused = False
        try:
            if args.restart:
                docker("restart", "oanda-worker")
            else:
                docker("pause", "oanda-worker")
                paused = True
                deadline = time.monotonic() + args.duration
                unavailable = set()
                while time.monotonic() < deadline:
                    for row in snapshots():
                        if row["quality"] == "unavailable":
                            unavailable.add(row["logical_symbol"])
                    time.sleep(1)
                result["degraded_symbols"] = sorted(unavailable)
                if unavailable != {row["logical_symbol"] for row in before}:
                    raise RuntimeError("Interrupted symbols were not reported unavailable")
                docker("unpause", "oanda-worker")
                paused = False
            resumed = time.monotonic()
            while time.monotonic() - resumed < 75:
                after = snapshots()
                if after and all(row["quality"] == "healthy" for row in after) and all(
                    row["connection_epoch"] > old["connection_epoch"]
                    for row, old in zip(after, before, strict=True)):
                    result["recovery_seconds"] = round(time.monotonic() - resumed, 3)
                    result["after"] = [{"symbol": row["logical_symbol"], "epoch": row["connection_epoch"],
                                        "confirmed_end": row["last_confirmed_m1"]} for row in after]
                    result["within_60s"] = result["recovery_seconds"] <= 60
                    break
                time.sleep(1)
            else:
                raise RuntimeError("Same-source readiness did not recover within 75 seconds")
        finally:
            if paused:
                docker("unpause", "oanda-worker")
        filename = "fault-restart.json" if args.restart else f"fault-pause-{args.duration}s.json"
        (ROOT / "docs/verification/data-integration" / filename).write_text(json.dumps(result, indent=2))
        print(json.dumps(result))


if __name__ == "__main__":
    main()
