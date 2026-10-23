"""Task-owned synthetic published history and real HTTP MCP verification for R1.

Run seed/step/drain/facts in the isolated API container. Host HTTP calls need
only the standard library. Credentials remain in the supplied private path.
"""

import argparse
import json
import sys
import urllib.request
from pathlib import Path

MARKER = "verification:mcp-history-indicators-20261023"
SPECS = [{"name": "EMA", "params": {"period": 19}},
         {"name": "RSI", "params": {"period": 14}}]


def write_json(path, value):
    path = Path(path)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")
    path.chmod(0o600)


def seed(private):
    import pytest
    from alerts.chart_indicators import calculate
    from alerts.history_artifacts import read_artifact
    from alerts.history_versions import create_version
    from alerts.mcp.auth import issue
    from alerts.storage import HistoryVersion, Preference, Session, now_ms
    from sqlalchemy import select

    sys.path.insert(0, "/fixtures/tests")
    from test_composite_definitions import publish
    from test_fixed_indicators import history
    from test_market_contracts import identity

    with Session.begin() as db:
        if db.get(Preference, MARKER):
            assert (private / "credentials.json").exists(), "preserve DB; seed credential is missing"
            print("existing task fixture retained")
            return
        assert db.scalar(select(HistoryVersion)) is None, "refuse to seed a nonempty history DB"
    with pytest.MonkeyPatch.context() as patch:
        version = history(Session, patch, count=2107)
        newer = publish(Session, end=2108 * 60000)
    with Session.begin() as db:
        unpublished = create_version(db, identity().key, 0, 2109 * 60000)
        rows = read_artifact(db, version, "M1", limit=20000)
        fixture = {"version": version, "newer": newer, "unpublished": unpublished,
                   "checksum": db.get(HistoryVersion, version).manifest["checksum"],
                   "expected": [calculate(rows[:1000], spec)["series"][0]["values"][-7:]
                                for spec in SPECS]}
        db.add(Preference(key=MARKER, value=fixture))
    token = issue("history-indicators-r1", ["market:read", "analysis:read"], now_ms() + 7 * 86400000)
    write_json(private / "credentials.json", {"token": token, **fixture})
    write_json(private / "fixture.json", fixture)
    print("synthetic versions seeded; credential stored privately")


def advance(private, *, finish):
    from alerts.fixed_indicators import indicator_tick
    from alerts.storage import FixedIndicatorRun, Session

    fixture = json.loads((private / "fixture.json").read_text())
    ids = json.loads((private / "runs.json").read_text())
    for ident in ids:
        with Session.begin() as db:
            run = db.get(FixedIndicatorRun, ident)
            assert run and run.history_version_id == fixture["version"] and run.revision_id is None
        if finish:
            for _ in range(100):
                if not indicator_tick(ident):
                    break
            else:
                raise AssertionError("fixture job did not finish")
        else:
            assert indicator_tick(ident)
    print(f"advanced {len(ids)} task-owned fixed indicator runs")


def facts():
    from alerts.storage import (
        HistoryArtifact,
        HistoryVersion,
        MarketDataset,
        MarketDemand,
        Session,
        SourceFetch,
    )
    from sqlalchemy import func, select

    with Session.begin() as db:
        return {"versions": sorted([v.id, v.status] for v in db.scalars(select(HistoryVersion))),
                **{model.__tablename__: db.scalar(select(func.count()).select_from(model))
                   for model in (MarketDataset, MarketDemand, HistoryArtifact, SourceFetch)}}


def verify(private, base_url, phase, output):
    creds = json.loads((private / "credentials.json").read_text())
    headers = {"Authorization": "Bearer " + creds["token"],
               "Accept": "application/json, text/event-stream", "Content-Type": "application/json",
               "MCP-Protocol-Version": "2025-11-25"}
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def rpc(method, params=None):
        data = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}).encode()
        request = urllib.request.Request(base_url.rstrip("/") + "/mcp", data=data, headers=headers)
        with opener.open(request, timeout=30) as response:
            result = json.load(response)
        assert "error" not in result, result
        return result["result"]

    rpc("initialize", {"protocolVersion": "2025-11-25", "capabilities": {},
                       "clientInfo": {"name": "history-r1", "version": "1"}})
    tools = rpc("tools/list")["tools"]
    tool = next(t for t in tools if t["name"] == "indicators_calculate")
    assert "history" in tool["inputSchema"]["properties"]["series_kind"]["enum"]
    arguments = {"instrument": creds["version"], "series_kind": "history", "timeframe": "M1",
                 "before": 1000 * 60000, "limit": 7, "indicators": SPECS}

    def call(**changes):
        return rpc("tools/call", {"name": "indicators_calculate", "arguments": arguments | changes})

    result = call()
    assert not result.get("isError"), result
    page = result["structuredContent"]["page"]
    assert page["version_id"] == page["history_version_id"] == creds["version"] != creds["newer"]
    assert page["history_checksum"] == creds["checksum"]
    assert page["input_manifest"] == {"version_id": creds["version"], "checksum": creds["checksum"]}
    assert len(page["bars"]) == 7
    bars = rpc("tools/call", {"name": "history_get_bars", "arguments": {
        "version_id": creds["version"], "timeframe": "M1", "before": arguments["before"], "count": 7}})
    assert not bars.get("isError") and page["bars"] == bars["structuredContent"]["bars"]
    for item in page["indicators"]:
        calc = item["calculation"]
        assert calc["input_evidence"]["history_version_id"] == creds["version"]
        assert calc["calculation_origin"] == 0
        assert {v["time"] for s in item["series"] for v in s["values"]} <= {b["start"] for b in page["bars"]}
    if phase == "cold":
        assert page["pending"] and all(not i["calculation"]["visible_complete"] for i in page["indicators"])
        write_json(private / "runs.json", [i["calculation"]["run_id"] for i in page["indicators"]])
    else:
        for item, expected in zip(page["indicators"], creds["expected"], strict=True):
            calc = item["calculation"]
            assert calc["visible_complete"] and calc["coverage"] == calc["required_coverage"]
            assert calc["status"] == ("partial" if phase == "partial" else "complete")
            assert item["series"][0]["values"] == expected
        normalized = call(instrument="MWH:" + creds["version"].upper())
        assert normalized["structuredContent"]["instrument"] == creds["version"]
        assert normalized["structuredContent"]["page"]["bars"] == page["bars"]
    failures = []
    for changes, code in (({"instrument": "00000000-0000-0000-0000-000000000001"}, "DATA_UNAVAILABLE"),
                          ({"instrument": creds["unpublished"]}, "DATA_UNAVAILABLE"),
                          ({"timeframe": "H1"}, "DATA_UNAVAILABLE"),
                          ({"published": True}, "INVALID_ARGUMENT"),
                          ({"instrument": "MWH:" + creds["version"], "series_kind": "managed"}, "INVALID_ARGUMENT")):
        failure = call(**changes)
        assert failure.get("isError") and failure["structuredContent"]["error"]["code"] == code, failure
        failures.append(failure)
    write_json(output, {"phase": phase, "tool_count": len(tools), "tool": tool,
                        "result": result, "negative_results": failures})
    print(f"{phase} real HTTP MCP verification passed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["seed", "step", "drain", "facts", "cold", "partial", "ready"])
    parser.add_argument("--private", type=Path, default=Path("/private"))
    parser.add_argument("--base-url", default="http://127.0.0.1:18633")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.mode == "seed":
        seed(args.private)
    elif args.mode in ("step", "drain"):
        advance(args.private, finish=args.mode == "drain")
    elif args.mode == "facts":
        write_json(args.output or args.private / "facts.json", facts())
    else:
        verify(args.private, args.base_url, args.mode, args.output or args.private / (args.mode + ".json"))


if __name__ == "__main__":
    main()
