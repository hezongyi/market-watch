"""Real HTTPS/API acceptance; credentials and original documents stay private."""

import argparse
import hashlib
import http.cookiejar
import json
import ssl
import statistics
import subprocess
import time
import urllib.parse
import urllib.request
from pathlib import Path


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    state = Path.home() / ".local/share/market-watch-dev"
    private = state / "updates/market-consolidation-20261113"
    credentials = json.loads((state / "credentials.json").read_text())
    opener = urllib.request.build_opener(
        urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile=credentials["ca_file"])),
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    csrf = None

    def call(path, body=None):
        headers = {"Content-Type": "application/json"}
        if csrf:
            headers["X-CSRF-Token"] = csrf
        request = urllib.request.Request(credentials["base_url"] + path, headers=headers,
            data=None if body is None else json.dumps(body).encode())
        with opener.open(request, timeout=90) as response:
            return json.load(response)

    assert call("/readyz")["status"] == "ready"
    csrf = call("/api/login", {"password": credentials["login_password"]})["csrf"]
    before = json.loads((private / "before-api.json").read_text())
    result = {"base": credentials["base_url"], "ready": True, "login": True, "preserved": {}}
    for path, original in before.items():
        if "composites" in path:
            continue
        current = call(path)
        if path.endswith("/preferences"):
            # Opening the actual chart host can re-save identical vendor
            # settings. Compare every preference's identity/content, while
            # recording metadata-only revisions separately.
            def content(rows):
                return [{key: value for key, value in row.items()
                    if key not in {"revision", "updated_at"}}
                    for row in sorted(rows, key=lambda item: item["id"])]
            assert fingerprint(content(original)) == fingerprint(content(current)), path
            result["preference_metadata_only_changes"] = [row["name"] for row in current
                if row != next(item for item in original if item["id"] == row["id"])]
        else:
            assert fingerprint(original) == fingerprint(current), f"Original saved document changed: {path}"
        result["preserved"][path] = {"count": len(current), "sha256": fingerprint(current)}
    old = before["/api/market-data/center/composites?page_size=100"]["items"]
    composites = call("/api/market-data/center/composites?page_size=100")["items"]
    assert {row["id"] for row in old} == {row["id"] for row in composites}
    result["continuations"] = []
    summaries = call("/api/market-data/center/dataset-summaries?view=continuation&page_size=100")
    for row in composites:
        original = next(item for item in old if item["id"] == row["id"])
        assert row["active_revision_id"] == original["active_revision_id"]
        assert row["revision"]["history_version_id"] == original["revision"]["history_version_id"]
        detail = call(f"/api/market-data/datasets/{row['dataset_id']}/continuation")
        summary = next(item for item in summaries["items"] if item["id"] == row["dataset_id"])
        assert detail["enabled"] and detail["status"] == summary["continuation"]["status"]
        assert row["status"] not in {"attention", "preparing"}, row["status"]
        assert any(config["id"] == row["id"] for config in detail["configurations"])
        review_required = not detail["ready_to_enable"]
        if review_required:
            # Old immutable configurations remain readable, even where their
            # product proof cannot authorize a new default under current rules.
            assert detail["status"] == "attention" and detail["reason"]
        else:
            assert detail["status"] == row["status"]
        result["continuations"].append({"id": row["id"], "status": detail["status"],
            "runtime_status": row["status"], "configuration_review_required": review_required,
            "configuration_reason": detail["reason"] if review_required else None,
            "revision": row["active_revision_id"], "confirmed_end": row["preparation"]["confirmed_end"]})

    def bars(ticker, kind, frame):
        page = call("/api/charts/data", {"instrument": ticker, "series_kind": kind,
            "timeframe": frame, "limit": 40, "firstDataRequest": True})
        values = page.get("bars", [])
        assert values, (kind, ticker, frame, list(page))
        for bar in values:
            high, low, opened, close = (float(bar[key]) for key in ("high", "low", "open", "close"))
            assert low <= min(opened, close) <= max(opened, close) <= high
        return len(values)

    result["charts"] = []
    for row in composites:
        for frame in ("M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN"):
            count = bars("MWC:" + row["id"], "composite", frame)
            result["charts"].append({"kind": "composite", "id": row["id"], "frame": frame, "bars": count})
        count = bars("MWH:" + row["revision"]["history_version_id"], "history", "H1")
        result["charts"].append({"kind": "history", "id": row["revision"]["history_version_id"], "frame": "H1", "bars": count})
    result["sources"] = []
    for source, query, frame in [("oanda", "EURUSD", "H1"), ("binance", "BTCUSDT", "H1"),
        ("dukascopy", "EURUSD", "H1"), ("yahoo", "SPY", "D1"), ("akshare", "000001", "D1"), ("fxcm", "EURUSD", "H1")]:
        query_string = urllib.parse.urlencode({"kind": "provider", "query": query, "source": source, "limit": 25})
        found = call("/api/market-data/series/search?" + query_string)
        candidates = found.get("items", []) if isinstance(found, dict) else found
        entry = next(item for item in candidates if item.get("source") == source and item.get("available", True))
        count = bars(entry["id"], "provider", frame)
        result["sources"].append({"source": source, "bars": count, "frame": frame})
        print(json.dumps(result["sources"][-1]), flush=True)
    timings = {}
    for name, endpoint in [("summary", "dataset-summaries"), ("legacy_full", "datasets")]:
        elapsed = []
        for _ in range(20):
            start = time.perf_counter()
            call("/api/market-data/center/" + endpoint + "?page_size=25")
            elapsed.append((time.perf_counter() - start) * 1000)
        timings[name] = {"median_ms": round(statistics.median(elapsed), 2),
            "p95_ms": round(sorted(elapsed)[18], 2), "requests": len(elapsed)}
    result["latency"] = timings
    # A temporary, read-only agent exercises the actual TLS/MCP transport.
    # Keep bearer material solely in memory; always revoke it afterwards.
    token = subprocess.check_output(["docker", "exec", "mw-dev-api-1", "python", "-c",
        "from alerts.mcp.auth import issue; from alerts.storage import now_ms; "
        "print(issue('consolidation-acceptance-20261113',['market:read','analysis:read'],now_ms()+600000))"],
        text=True).strip()
    result["mcp"] = []
    try:
        def rpc(method, params):
            request = urllib.request.Request(credentials["base_url"] + "/mcp",
                data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
                headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream",
                    "MCP-Protocol-Version": "2025-11-25", "Authorization": "Bearer " + token})
            with opener.open(request, timeout=90) as response:
                return json.load(response)["result"]
        rpc("initialize", {"protocolVersion": "2025-11-25", "capabilities": {},
            "clientInfo": {"name": "consolidation-acceptance", "version": "1"}})
        for row in composites:
            for tool, arguments in [
                ("composite_get_bars", {"composite_id": row["id"], "count": 40, "timeframe": "H1"}),
                ("history_get_bars", {"version_id": row["revision"]["history_version_id"], "count": 40, "timeframe": "H1"})]:
                value = rpc("tools/call", {"name": tool, "arguments": arguments})
                assert not value.get("isError"), value
                data = value["structuredContent"]
                assert data.get("bars"), (tool, list(data))
                result["mcp"].append({"tool": tool, "bars": len(data["bars"]), "passed": True})
    finally:
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        subprocess.run(["docker", "exec", "mw-dev-api-1", "python", "-c",
            "from alerts.mcp.auth import revoke; revoke('" + token_hash + "')"], check=True,
            capture_output=True, text=True)
        result["mcp_credential_revoked"] = True
    health = call("/api/health")
    result["runtime"] = {group: [{"role": row["role"], "state": row["state"], "error": row.get("error_type")}
        for row in health[group]] for group in ["market_runtime", "data_runtime", "notification_runtime"]}
    assert all(row["state"] not in {"missing", "stale", "degraded", "failed"} and not row["error"]
        for rows in result["runtime"].values() for row in rows), result["runtime"]
    result["passed"] = True
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"passed": True, "charts": len(result["charts"]), "sources": result["sources"],
        "latency": timings, "runtime": result["runtime"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
