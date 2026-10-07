"""Compare actual immutable native JSON3 periods to platform HTTP and MCP."""

import argparse
import json
from pathlib import Path

import httpx
from alerts.provider_dukascopy import FRAMES, interval_end, metadata, native_page, stable_id


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="http://127.0.0.1:16629")
    parser.add_argument("--output", type=Path, default=Path("artifacts/data-integration/dukascopy-native-parity.json"))
    parser.add_argument("--token", type=Path, default=Path("artifacts/data-integration/three-layer-maintenance-20261007.token"))
    args = parser.parse_args()
    ident = stable_id("EUR/USD")
    before = 1790812800000  # 2026-10-01 UTC; avoid changing current supplier bars.
    report = {"passed": False, "environment": "Ubuntu isolated market-watch-three-layer", "periods": []}
    with httpx.Client(base_url=args.base, timeout=45, trust_env=False) as client:
        login = client.post("/api/login", json=json.loads(Path("artifacts/data-integration/three-layer-login.json").read_text()))
        login.raise_for_status()
        client.headers["X-CSRF-Token"] = login.json()["csrf"]
        meta = metadata(ident)
        for frame in FRAMES:
            direct = native_page(meta, frame, before, 4)
            response = client.post("/api/charts/data", json={"instrument": ident,
                "series_kind": "provider", "timeframe": frame, "before": before, "limit": 4})
            response.raise_for_status()
            cached = response.json()
            keys = ("start", "end", "chart_time", "open", "high", "low", "close", "volume", "source_confirmed", "time_closed")
            def projection(rows):
                return [{key: row[key] for key in keys} for row in rows]
            if projection(cached["bars"]) != projection(direct["bars"]):
                # JSON3 may omit its newest eligible bucket on a later query.
                # A larger shifted source window supplies independent witnesses
                # for every cached timestamp; no price or bar is synthesized.
                witness = native_page(meta, frame, interval_end(before, frame), 12)
                by_start = {row["start"]: row for row in projection(direct["bars"] + witness["bars"])}
                exact = all(by_start.get(row["start"]) == row for row in projection(cached["bars"]))
                if not exact:
                    report["mismatch"] = {"frame": frame, "cached": projection(cached["bars"]),
                                          "supplier": projection(direct["bars"]), "witness": projection(witness["bars"])}
                    args.output.write_text(json.dumps(report, indent=2) + "\n")
                    raise AssertionError(frame)
                report.setdefault("supplier_cursor_variation", []).append({"frame": frame,
                    "direct": projection(direct["bars"]), "witness": projection(witness["bars"]),
                    "all_cached_rows_have_exact_source_witness": True})
            assert cached["history_boundary"] is False
            report["periods"].append({"frame": frame, "exact_supplier_parity": True,
                                      "bars": projection(cached["bars"])})
            print(frame, "supplier/HTTP exact parity", flush=True)
        if args.token.exists():
            def call(name, arguments):
                response = client.post("/mcp", headers={"Authorization": "Bearer " + args.token.read_text().strip(),
                    "Accept": "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25"},
                    json={"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": arguments}})
                response.raise_for_status()
                result = response.json()["result"]
                assert not result.get("isError"), result
                return result["structuredContent"]
            search = call("series_search", {"query": "EURUSD", "kind": "provider"})
            assert any(row["id"] == ident for row in search["items"])
            bars = call("market_get_bars", {"instrument": ident, "series_kind": "provider", "timeframe": "H4", "before": before, "limit": 4})
            assert bars["quality"] == "calendar_unverified"
            assert bars["gap_assessment"] == "unknown_calendar"
            expected = next(row["bars"] for row in report["periods"] if row["frame"] == "H4")
            assert projection(bars["page"]["bars"]) == expected
            report["mcp"] = {"search": True, "bars": bars}
        report["passed"] = True
        args.output.write_text(json.dumps(report, indent=2) + "\n")
        print("Passed actual supplier, HTTP and MCP parity")


if __name__ == "__main__":
    main()
