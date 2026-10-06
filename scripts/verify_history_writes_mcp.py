"""Actual maintenance write MCP; only explicitly test-owned derived data reclaimed."""

import argparse
import json
import time
from pathlib import Path

import httpx


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--step", choices=("queue", "verify"), required=True)
    parser.add_argument("--base", default="http://127.0.0.1:16629")
    parser.add_argument("--login", type=Path, default=Path("artifacts/data-integration/three-layer-login.json"))
    parser.add_argument("--token", type=Path, default=Path("artifacts/data-integration/three-layer-maintenance-20261007.token"))
    parser.add_argument("--output", type=Path, default=Path("artifacts/data-integration/history-writes-mcp-real.json"))
    args = parser.parse_args()
    with httpx.Client(base_url=args.base, timeout=30, trust_env=False) as client:
        login = client.post("/api/login", json=json.loads(args.login.read_text()))
        login.raise_for_status()
        client.headers["X-CSRF-Token"] = login.json()["csrf"]
        token = args.token.read_text().strip()

        def web(path, body=None):
            response = client.get("/api/" + path) if body is None else client.post("/api/" + path, json=body)
            response.raise_for_status()
            return response.json()

        def rpc(method, params=None):
            response = client.post("/mcp", headers={"Authorization": "Bearer " + token,
                "Accept": "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25"},
                json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}})
            response.raise_for_status()
            return response.json()["result"]

        def call(name, body, *, error=False):
            result = rpc("tools/call", {"name": name, "arguments": body})
            assert result["isError"] == error, result
            return result["structuredContent"]

        def write(name, body, key):
            body = {**body, "idempotency_key": "real-maintenance-audusd-20261007-" + key}
            first = call(name, body)
            assert call(name, body) == first, name
            return first

        def wait_version(ident):
            deadline = time.monotonic() + 240
            while time.monotonic() < deadline:
                row = web("market-data/versions/" + ident)
                if row["status"] == "published":
                    return row
                assert row["status"] not in ("configuration_error", "cancelled", "failed"), row
                time.sleep(2)
            raise AssertionError("Actual supplier/derivation version did not publish: " + ident)

        names = {row["name"] for row in rpc("tools/list")["tools"]}
        expected = {"history_" + name for name in ("create_dataset", "configure_maintenance",
            "control_maintenance", "submit_task", "control_task", "change_aggregation",
            "request_artifacts", "reclaim_dataset")}
        assert expected <= names
        if args.step == "queue":
            cutoff = (int(time.time() * 1000) - 5000) // 60000 * 60000
            plan = {"target_start": cutoff - 120 * 60000, "timeframes": ["M1"], "frequency": "once"}
            result = write("history_create_dataset", {"dataset": {"source": "oanda",
                "logical_symbol": "AUDUSD", "provider_symbol": "AUD_USD", "asset_class": "forex",
                "precision": 5, "aggregation_calendar": "ny17"}, "maintenance": plan}, "create")
            dataset, initial = result["dataset"]["id"], result["task"]["id"]
            write("history_control_task", {"version_id": initial, "action": "pause"}, "pause-task")
            configured = write("history_configure_maintenance", {"dataset_id": dataset,
                "maintenance": {**plan, "daily_minute": 60}}, "configure")
            assert configured == web("market-data/datasets/" + dataset + "/maintenance")
            cancelled = write("history_control_task", {"version_id": initial, "action": "cancel"}, "cancel-task")
            assert cancelled["desired_state"] == "cancelled"
            task = write("history_submit_task", {"dataset_id": dataset, "kind": "backfill",
                "start": plan["target_start"], "end": cutoff}, "supplier-task")
            args.output.write_text(json.dumps({"environment": "Ubuntu isolated market-watch-three-layer",
                "base": args.base, "dataset_id": dataset, "version_id": task["id"],
                "initial_cancelled": initial, "tools_discovered": sorted(expected), "passed": False}, indent=2) + "\n")
            print(json.dumps({"queued": True, "version_id": task["id"]}), flush=True)
            return

        report = json.loads(args.output.read_text())
        dataset, version = report["dataset_id"], report["version_id"]
        published = wait_version(version)
        bars = web("market-data/versions/" + version + "/chart?count=2000")["bars"]
        assert bars and published["manifest"]["identity"]["source"] == "oanda"
        changed = write("history_change_aggregation", {"dataset_id": dataset,
            "aggregation": {"aggregation_calendar": "utc0", "version_id": version}}, "derive")
        destination, derived = changed["dataset"]["id"], changed["version"]["id"]
        report.update(derived_dataset_id=destination, derived_version_id=derived)
        args.output.write_text(json.dumps(report, indent=2) + "\n")
        wait_version(derived)
        write("history_request_artifacts", {"version_id": derived, "timeframes": ["M1", "H4"]}, "periods")
        deadline = time.monotonic() + 240
        while time.monotonic() < deadline:
            periods = web("market-data/versions/" + derived + "/artifacts")
            if {row["timeframe"] for row in periods if row["status"] == "published"} >= {"M1", "H4"}:
                break
            time.sleep(2)
        else:
            raise AssertionError("Derived periods did not publish")
        derived_bars = web("market-data/versions/" + derived + "/chart?count=2000")["bars"]
        assert [{k: v for k, v in row.items() if k not in ("parent_version_id", "rule_version")} for row in bars] == [
            {k: v for k, v in row.items() if k not in ("parent_version_id", "rule_version")} for row in derived_bars]
        for ident in (dataset, destination):
            for action in ("pause", "archive"):
                write("history_control_maintenance", {"dataset_id": ident, "action": action}, ident[:8] + action)
        denied_parent = call("history_reclaim_dataset", {"dataset_id": dataset,
            "idempotency_key": "real-maintenance-parent-protected"}, error=True)
        assert denied_parent["error"]["code"] == "DATA_UNAVAILABLE"
        workspace = web("charts/workspaces", {"name": "maintenance MCP acceptance owned reference"})
        document = workspace["document"]
        document["history_version_id"] = derived
        workspace = web("charts/workspaces/" + workspace["id"] + "/save", {
            "name": workspace["name"], "revision": workspace["revision"], "document": document})
        report["test_owned_workspace"] = {"id": workspace["id"], "revision": workspace["revision"]}
        args.output.write_text(json.dumps(report, indent=2) + "\n")
        try:
            denied = call("history_reclaim_dataset", {"dataset_id": destination,
                "idempotency_key": "real-maintenance-workspace-protected"}, error=True)
            assert denied["error"]["code"] == "DATA_UNAVAILABLE"
        finally:
            web("charts/workspaces/" + workspace["id"] + "/delete", {"revision": workspace["revision"]})
        reclaimed = write("history_reclaim_dataset", {"dataset_id": destination}, "reclaim-derived")
        assert reclaimed["versions"] == 1
        assert not web("market-data/versions/" + derived)["payload_available"]
        assert web("market-data/versions/" + version)["payload_available"]
        assert web("market-data/versions/" + version + "/chart?count=2000")["bars"] == bars
        write("history_control_maintenance", {"dataset_id": dataset, "action": "unarchive"}, "preserve-parent")
        report.update(passed=True, supplier_m1_rows=len(bars), unchanged_derived_m1=True,
            browser_plan_parity=True, idempotency=True, parent_reference_protected=True,
            workspace_reference_protected=True, test_owned_derived_reclaimed=True)
        args.output.write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps({"tools": len(expected), "supplier_m1_rows": len(bars), "passed": True}), flush=True)


if __name__ == "__main__":
    main()
