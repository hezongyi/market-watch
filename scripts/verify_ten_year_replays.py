"""Exercise real ten-year pinned versions through the isolated authenticated API."""

import hashlib
import json
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def main():
    result = {"host": "Ubuntu local isolated Docker", "passed": False,
              "scope": "bounded replay windows pinned to actual published ten-year versions", "runs": []}
    with httpx.Client(base_url="http://127.0.0.1:16589", timeout=600, trust_env=False) as client:
        response = client.post("/api/login", json=json.loads(
            (ROOT / "artifacts/data-integration/login.json").read_text()))
        response.raise_for_status()
        client.headers["X-CSRF-Token"] = response.json()["csrf"]

        def request(path, body=None):
            response = client.get(path) if body is None else client.post(path, json=body)
            response.raise_for_status()
            return response.json()

        datasets = {row["id"]: row for row in request("/api/market-data/datasets")}
        versions = [row for row in request("/api/market-data/versions") if row["status"] == "published"
                    and row["end"] - row["start"] >= 9 * 365 * 86400000]
        if {datasets[v["dataset_id"]]["logical_symbol"] for v in versions} != {"EURUSD", "XAUUSD"}:
            raise RuntimeError("Both published ten-year versions are required")
        for version in versions:
            dataset = datasets[version["dataset_id"]]
            # The EUR range contains original six-place observations; XAU uses
            # the same actual date, exercising years of immutable warmup.
            start, end = 1728515100000, 1728515700000
            started = time.monotonic()
            run = request("/api/replays", {"instrument_id": dataset["instrument_id"],
                "dataset_version": version["id"], "timeframe": "M1", "start": start, "end": end})
            creation_seconds = round(time.monotonic() - started, 3)
            if run["input_manifest"] != version["manifest"] or run["dataset_version"] != version["id"]:
                raise RuntimeError("The actual replay did not pin the requested source/version")
            if any(row["end"] > run["cursor"] for row in run["bars"]):
                raise RuntimeError("Replay exposed a future event before stepping")
            stepped = request("/api/replays/" + run["id"] + "/step", {"count": 1})
            if stepped["cursor"] <= start or stepped["input_manifest"] != run["input_manifest"]:
                raise RuntimeError("Actual source replay did not advance with its fixed manifest")
            branch = request("/api/replays/" + run["id"] + "/seek", {"cursor": stepped["cursor"]})
            if (branch["dataset_version"] != run["dataset_version"]
                    or branch["input_manifest"] != run["input_manifest"]):
                raise RuntimeError("Seek lost original source provenance")
            before = digest(request("/api/replays/" + run["id"]))
            revised = request("/api/market-data/versions", {
                "dataset_id": version["dataset_id"], "start": start, "end": end})
            deadline = time.monotonic() + 120
            while time.monotonic() < deadline:
                current = request("/api/market-data/versions/" + revised["id"])
                if current["status"] == "published":
                    break
                if current["status"] == "configuration_error":
                    raise RuntimeError("The real bounded reimport hit a configuration fault")
                time.sleep(2)
            else:
                raise RuntimeError("Real bounded reimport did not publish within 120 seconds")
            after = digest(request("/api/replays/" + run["id"]))
            if before != after or request("/api/market-data/versions/" + version["id"])["manifest"] != version["manifest"]:
                raise RuntimeError("Actual reimport changed a pinned replay or its original manifest")
            item = {"symbol": dataset["logical_symbol"], "version": version["id"], "run": run["id"],
                "seek_branch": branch["id"], "start": start, "end": end,
                "creation_seconds": creation_seconds, "warmup_bar_count": run["warmup_bar_count"],
                "stepped_cursor": stepped["cursor"], "identity": dataset["identity"],
                "manifest_checksum": version["manifest"]["checksum"], "reimport_version": revised["id"],
                "reimport_rows": current["manifest"]["rows"], "before": before, "after": after,
                "pinned_inputs_unchanged": True}
            result["runs"].append(item)
            print(json.dumps({"event": "ten_year_replay_verified", **item}), flush=True)
        result["passed"] = True
        (ROOT / "docs/verification/data-integration/ten-year-replays.json").write_text(
            json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
