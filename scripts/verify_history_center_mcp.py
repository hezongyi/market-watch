"""Read-only actual HTTP/MCP parity; login and bearer stay in ignored files."""

import argparse
import json
from pathlib import Path
from urllib.parse import urlencode

import httpx


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:16629")
    parser.add_argument("--login", type=Path, default=Path("artifacts/data-integration/three-layer-login.json"))
    parser.add_argument("--token", type=Path, default=Path("artifacts/data-integration/three-layer-read-acceptance-token"))
    parser.add_argument("--output", type=Path, default=Path("artifacts/data-integration/history-center-mcp-real.json"))
    parser.add_argument("--creation-version", help="Optional existing, owned creation task; reads its fixed request only")
    args = parser.parse_args()
    token = args.token.read_text().strip()
    with httpx.Client(base_url=args.base, timeout=30, trust_env=False) as client:
        client.get("/readyz").raise_for_status()
        response = client.post("/api/login", json=json.loads(args.login.read_text()))
        response.raise_for_status()
        def get(path):
            response = client.get("/api/market-data/" + path)
            response.raise_for_status()
            return response.json()
        def rpc(method, params=None):
            response = client.post("/mcp", headers={"Authorization": "Bearer " + token,
                "Accept": "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25"},
                json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}})
            response.raise_for_status()
            return response.json()["result"]
        datasets = get("center/datasets?status=available")
        row = next(item for item in datasets["items"] if item["latest_version_id"])
        dataset, version = row["id"], row["latest_version_id"]
        cases = {
            "history_list_datasets": ({"status": "available"}, "center/datasets?status=available"),
            "history_get_dataset": ({"dataset_id": dataset}, "center/datasets/" + dataset),
            "history_get_version": ({"version_id": version}, "versions/" + version),
            "history_get_bars": ({"version_id": version, "count": 2}, f"versions/{version}/chart?count=2"),
            "history_get_coverage": ({"version_id": version}, f"versions/{version}/coverage"),
            "history_get_requests": ({"version_id": version}, f"versions/{version}/requests"),
            "history_get_references": ({"dataset_id": dataset}, f"datasets/{dataset}/references"),
            "history_list_tasks": ({"dataset_id": dataset}, f"center/tasks?dataset_id={dataset}"),
            "history_get_comparison": ({"version_id": version}, f"versions/{version}/comparison"),
            "history_get_creation": ({"request_id": "acceptance-not-submitted", "source": "dukascopy",
                "provider_symbol": "EUR/USD"}, "center/creations/acceptance-not-submitted?source=dukascopy&provider_symbol=EUR/USD"),
        }
        listed = {item["name"]: item for item in rpc("tools/list")["tools"]}
        records = []
        for name, (arguments, path) in cases.items():
            assert listed[name]["annotations"]["readOnlyHint"]
            result = rpc("tools/call", {"name": name, "arguments": arguments})
            assert not result["isError"]
            assert result["structuredContent"] == get(path), name
            records.append({"tool": name, "browser_parity": True})
        for status in ("active", "attention", "history", "paused"):
            arguments = {"status": status, "query": "EURUSD", "source": "dukascopy", "page_size": 1}
            result = rpc("tools/call", {"name": "history_list_tasks", "arguments": arguments})
            assert not result["isError"]
            assert result["structuredContent"] == get("center/tasks?" + urlencode(arguments))
            records.append({"tool": "history_list_tasks", "status": status, "browser_parity": True})
        if args.creation_version:
            owned = get("versions/" + args.creation_version)["manifest"]["maintenance"]["creation_request"]
            fields = {key: owned["dataset"][key] for key in ("source", "provider_symbol", "asset_class", "aggregation_calendar")}
            result = rpc("tools/call", {"name": "history_get_creation",
                "arguments": {"request_id": owned["request_id"], **fields}})
            assert not result["isError"]
            actual = get("center/creations/" + owned["request_id"] + "?" + urlencode(fields))
            assert actual["found"] and actual["task"]["id"] == args.creation_version
            assert result["structuredContent"] == actual
            records.append({"tool": "history_get_creation", "found": True, "browser_parity": True})
        page = rpc("tools/call", {"name": "history_get_bars",
            "arguments": {"version_id": version, "count": 2}})["structuredContent"]
        if page["next_before"] is not None:
            older = rpc("tools/call", {"name": "history_get_bars", "arguments": {
                "version_id": version, "count": 2, "before": page["next_before"]}})["structuredContent"]
            assert older["version_id"] == version
            assert all(bar["start"] < page["bars"][0]["start"] for bar in older["bars"])
        result = rpc("tools/call", {"name": "history_get_bars", "arguments": {"version_id": "missing"}})
        assert result["isError"] and result["structuredContent"]["error"]["code"] == "DATA_UNAVAILABLE"
    report = {"environment": "Ubuntu isolated market-watch-three-layer", "base": args.base,
        "dataset_id": dataset, "version_id": version, "records": records,
        "fixed_parent_and_exclusive_pagination": True, "unavailable_is_error": True, "passed": True}
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"tools": len(records), "browser_parity": True, "passed": True}))


if __name__ == "__main__":
    main()
