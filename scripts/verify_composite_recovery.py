"""Actual 120-second owned pricing-worker outage with persistent fixed watches."""

import argparse
import json
import subprocess
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
CONTAINER = "market-watch-three-layer-pricing-worker-1"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    setup = json.loads((ROOT / "artifacts/data-integration/concurrency10-real-01.json").read_text())
    report = {
        "environment": "Ubuntu isolated market-watch-three-layer",
        "passed": False,
        "outage_seconds": 120,
        "samples": [],
        "failures": [],
    }

    def save():
        args.output.write_text(json.dumps(report, indent=2) + "\n")

    def docker(operation):
        # Exact owned service only. Never switch networks, production or other projects.
        subprocess.run(
            ["sg", "docker", "-c", "docker " + operation + " " + CONTAINER],
            check=True,
            timeout=45,
            capture_output=True,
            text=True,
        )

    with httpx.Client(base_url="http://127.0.0.1:16629", trust_env=False, timeout=60) as client:
        login = client.post(
            "/api/login",
            json=json.loads(
                (ROOT / "artifacts/data-integration/three-layer-login.json").read_text()
            ),
        )
        login.raise_for_status()

        def read(route):
            response = client.get("/api/" + route)
            response.raise_for_status()
            return response.json()

        def sample(phase):
            rows = {r["id"]: r for r in read("watches")}
            values = []
            for row in setup["records"]:
                w = rows[row["watch_id"]]
                assert (
                    w["status"] == "active"
                    and w["market_identity"]["composite_revision_id"] == row["revision_id"]
                )
                values.append(
                    {
                        "symbol": row["symbol"],
                        "health": w["health"],
                        "reason": w["health_reason"],
                        "confirmed_end": w["runtime"].get("confirmed_end"),
                        "epoch": w["runtime"].get("epoch"),
                        "recovering": w["runtime"].get("recovering"),
                    }
                )
            report["samples"].append(
                {"phase": phase, "at": int(time.time() * 1000), "watches": values}
            )
            save()
            return values

        # Permit the next fixed aggregate waterline to settle before snapshot.
        start = time.monotonic()
        while True:
            before = sample("before")
            if all(v["health"] == "ready" for v in before):
                break
            if time.monotonic() - start > 180:
                raise AssertionError("Pre-outage watches did not become ready")
            time.sleep(2)
        originals = {row["symbol"]: row for row in before}
        try:
            docker("stop --time 15")
            report["stopped_at"] = int(time.time() * 1000)
            save()
            print(
                json.dumps({"event": "owned_worker_stopped", "at": report["stopped_at"]}),
                flush=True,
            )
            start = time.monotonic()
            while time.monotonic() - start < 120:
                values = sample("outage")
                if time.monotonic() - start >= 30:
                    assert all(v["health"] != "ready" for v in values)
                time.sleep(min(5, max(0.1, 120 - (time.monotonic() - start))))
            # Historical data remains readable without fabricating outage minutes.
            report["outage_charts"] = []
            for row in setup["records"]:
                page = read(
                    f"market-data/composites/{row['composite_id']}/chart?timeframe=M1&count=3&revision_id={row['revision_id']}"
                )
                assert page["bars"]
                report["outage_charts"].append(
                    {
                        "symbol": row["symbol"],
                        "latest_end": page["bars"][-1]["end"],
                        "revision_id": page["revision_id"],
                    }
                )
        except Exception as error:
            report["failures"].append({"phase": "outage", "type": type(error).__name__})
            raise
        finally:
            docker("start")
            report["restarted_at"] = int(time.time() * 1000)
            save()
            print(
                json.dumps({"event": "owned_worker_restarted", "at": report["restarted_at"]}),
                flush=True,
            )
        start = time.monotonic()
        while time.monotonic() - start < 300:
            values = sample("recovery")
            if all(
                v["health"] == "ready"
                and v["epoch"] > originals[v["symbol"]]["epoch"]
                and v["confirmed_end"] > originals[v["symbol"]]["confirmed_end"]
                for v in values
            ):
                report.update(
                    passed=True,
                    recovery_seconds=round(time.monotonic() - start, 3),
                    fixed_bindings_unchanged=True,
                    history_readable_during_outage=True,
                    strategy_gates_closed_during_outage=True,
                )
                save()
                print(
                    json.dumps({"passed": True, "recovery_seconds": report["recovery_seconds"]}),
                    flush=True,
                )
                return
            time.sleep(2)
        report["failures"].append({"phase": "recovery", "type": "bounded_timeout"})
        save()
        raise AssertionError("Fixed strategies did not recover in 300s")


if __name__ == "__main__":
    main()
