"""Actual six-tool read parity with fixed inputs; secrets remain in ignored files."""

import argparse
import json
from pathlib import Path

import httpx


def stable_read(value):
    # HTTP and MCP are sequential observations of the same quote. Its age uses
    # wall-clock now; all readiness, source times and input identities must match.
    if isinstance(value, dict):
        return {key: stable_read(item) for key, item in value.items() if key != "quote_age_ms"}
    if isinstance(value, list):
        return [stable_read(item) for item in value]
    return value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:16629")
    parser.add_argument("--login", type=Path, default=Path("artifacts/data-integration/three-layer-login.json"))
    parser.add_argument("--token", type=Path, default=Path("artifacts/data-integration/composite-read-acceptance-token"))
    parser.add_argument("--output", type=Path, default=Path("artifacts/data-integration/composite-center-mcp-real.json"))
    args = parser.parse_args()
    token = args.token.read_text().strip()
    with httpx.Client(base_url=args.base, timeout=30, trust_env=False) as client:
        client.get("/readyz").raise_for_status()
        client.post("/api/login", json=json.loads(args.login.read_text())).raise_for_status()

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

        listing = get("center/composites")
        row = next(item for item in listing["items"] if item["logical_symbol"] == "EURUSD")
        composite, dataset = row["id"], row["dataset_id"]
        revision, inputs = row["active_revision_id"], row["preparation"]["input_revision"]
        fixed = {"composite_id": composite, "revision_id": revision, "input_revision": inputs,
                 "count": 2, "timeframe": "H4"}
        chart_path = f"composites/{composite}/chart?revision_id={revision}&input_revision={inputs}&count=2&timeframe=H4"
        cases = {
            "series_search": ({"query": "EURUSD"}, "series/search?query=EURUSD"),
            "composite_list": ({}, "center/composites"),
            "composite_list_candidates": ({"query": "EURUSD"}, "center/composite-candidates?query=EURUSD"),
            "composite_get_mappings": ({"dataset_id": dataset}, f"datasets/{dataset}/mappings"),
            "composite_get": ({"composite_id": composite}, f"composites/{composite}"),
            "composite_get_requests": ({"composite_id": composite}, f"composites/{composite}/requests"),
            "composite_get_bars": (fixed, chart_path),
        }
        tools = {item["name"]: item for item in rpc("tools/list")["tools"]}
        records = []
        for name, (arguments, path) in cases.items():
            assert tools[name]["annotations"]["readOnlyHint"]
            result = rpc("tools/call", {"name": name, "arguments": arguments})
            assert not result["isError"], name
            browser = get(path)
            expected = {"items": browser} if name == "series_search" else browser
            assert stable_read(result["structuredContent"]) == stable_read(expected), name
            records.append({"tool": name, "browser_parity": True})
        page = get(chart_path)
        assert page["bars"] and page["revision_id"] == revision and page["input_revision"] == inputs
        assert all(key in page["bars"][-1] for key in ("time_closed", "source_confirmed", "coverage_complete", "segments"))
        if page["next_before"] is not None:
            older = rpc("tools/call", {"name": "composite_get_bars", "arguments": {
                **fixed, "before": page["next_before"]}})["structuredContent"]
            assert older["input_revision"] == inputs and older["revision_id"] == revision
            assert all(bar["start"] < page["bars"][0]["start"] for bar in older["bars"])
        missing = rpc("tools/call", {"name": "composite_get", "arguments": {"composite_id": "f" * 64}})
        assert missing["isError"] and missing["structuredContent"]["error"]["code"] == "DATA_UNAVAILABLE"
        final = get("center/composites")
        assert [(r["id"], r["usage"]) for r in final["items"]] == [(r["id"], r["usage"]) for r in listing["items"]]
    report = {"environment": "Ubuntu isolated market-watch-three-layer", "base": args.base,
        "composite_id": composite, "revision_id": revision, "input_revision": inputs,
        "records": records, "fixed_input_exclusive_pagination": True,
        "unchanged_definitions_and_demand": True, "passed": True}
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"tools": len(records), "browser_parity": True, "passed": True}))


if __name__ == "__main__":
    main()
