"""Actual fixed composite strategy HTTP/MCP/worker acceptance on Ubuntu.

Test-owned one-shot watches are cancelled in finally; delivery remains disabled.
Supplier prices are never changed, and historical notifications are not fabricated.
"""

import argparse
import json
import time
from decimal import Decimal
from pathlib import Path

import httpx


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--token", type=Path, default=Path("artifacts/data-integration/composite-watch-acceptance.token"))
    args = parser.parse_args()
    report = {"environment": "Ubuntu isolated market-watch-three-layer", "base": "http://127.0.0.1:16629",
        "passed": False, "watch_ids": [], "watches": [], "delivery_enabled": False}
    token = args.token.read_text().strip()
    with httpx.Client(base_url=report["base"], timeout=45, trust_env=False) as client:
        login = client.post("/api/login", json=json.loads(Path("artifacts/data-integration/three-layer-login.json").read_text()))
        login.raise_for_status()
        client.headers["X-CSRF-Token"] = login.json()["csrf"]

        def web(method, path, body=None):
            response = client.request(method, "/api/" + path, json=body)
            response.raise_for_status()
            return response.json()

        def call(name, body):
            response = client.post("/mcp", headers={"Authorization": "Bearer " + token,
                "Accept": "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25"},
                json={"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": body}})
            response.raise_for_status()
            result = response.json()["result"]
            assert not result.get("isError"), result
            return result["structuredContent"]

        try:
            existing = json.loads(Path("artifacts/data-integration/cross-source-setup.json").read_text())["records"]
            target = next(row for row in existing if row["symbol"] == "EURUSD")
            composite = target["composite_id"]
            original = web("GET", "market-data/composites/" + composite)
            assert original["historical_source"] == "dukascopy"
            start = time.monotonic()
            rules = [
                {"kind": "price", "timeframe": "M1", "level": "999999"},
                {"kind": "pullback", "timeframe": "M1", "consecutive": 100},
                {"kind": "previous_day", "timeframe": "M1", "seam_policy": "accept_raw"},
                {"kind": "indicator", "timeframe": "M1", "indicator_params": {"fast": 2, "slow": 19}, "seam_policy": "accept_raw"},
                {"kind": "price", "timeframe": "tick", "level": "999999"},
            ]
            for index, rule in enumerate(rules):
                watch = {"instrument_id": composite, "series_kind": "composite", "name": "acceptance composite strategy " + str(index),
                    "direction": "buy", **rule}
                if index == 3:
                    body = {"idempotency_key": "composite-strategy-real-sma-" + str(int(time.time()*1000)), "watch": watch}
                    result = call("alerts_create", body)
                    assert call("alerts_create", body) == result
                    report["mcp_write_idempotency"] = True
                else:
                    result = web("POST", "watches", watch)
                report["watch_ids"].append(result["id"])
                args.output.write_text(json.dumps(report, indent=2) + "\n")
                assert result["market_identity"]["composite_revision_id"] == original["active_revision_id"]
                assert result["health"] == "warming"
            while time.monotonic() - start < 180:
                rows = [row for row in web("GET", "watches") if row["id"] in report["watch_ids"]]
                assert all(row["health"] not in ("error", "blocked") for row in rows), rows
                # An actual incomplete prior day must remain gated. Ready is
                # required for price, formation, SMA and sampled quotes; the
                # daily rule is separately checked against its fixed artifact.
                if len(rows) == 5 and all(row["health"] == "ready" for row in rows if row["rule"]["kind"] != "previous_day") and (
                        next(row for row in rows if row["rule"]["kind"] == "previous_day")["health"] in ("ready", "warming")):
                    break
                time.sleep(1)
            else:
                report["watches"] = rows
                raise AssertionError("actual strategy inputs did not become ready")
            report["preparation_seconds"] = round(time.monotonic() - start, 3)
            before = {row["id"]: row for row in rows}
            # No browser chart lease was created. Persistent watch demand alone
            # must retain stream and confirmation while the client is idle.
            status = web("GET", "market-data/composites/" + composite)
            assert status["usage"]["strategies"] >= sum(row["status"] == "active" for row in rows)
            daily = next(row for row in rows if row["rule"]["kind"] == "previous_day")
            if daily["health"] != "ready":
                assert "交易日" in daily["health_reason"], daily
                from datetime import datetime, timedelta
                from zoneinfo import ZoneInfo

                local = datetime.now(ZoneInfo("America/New_York"))
                boundary = local.replace(hour=17, minute=0, second=0, microsecond=0)
                if local < boundary:
                    boundary -= timedelta(days=1)
                daily_page = web("GET", f"market-data/composites/{composite}/chart?timeframe=D1&count=1"
                    f"&before={int(boundary.timestamp()*1000)}&revision_id={daily['market_identity']['composite_revision_id']}"
                    f"&input_revision={daily['runtime']['processed_input_revision']}")
                assert not daily_page["bars"] or not daily_page["bars"][-1]["complete"] or (
                    daily_page["bars"][-1]["end"] != int(boundary.timestamp()*1000)), daily_page
                assert status["health"]["strategy_readiness"] == "pending_dependency_validation"
                report["actual_daily_dependency_gate"] = {"health": daily["health"],
                    "reason": daily["health_reason"], "fixed_daily_input": daily_page}
            else:
                assert status["health"]["strategy_readiness"] == "ready", status["health"]
            assert status["health"]["confirmed_tail_ready"]
            deadline = time.monotonic() + 90
            while time.monotonic() < deadline:
                rows = [row for row in web("GET", "watches") if row["id"] in report["watch_ids"]]
                tick = next(row for row in rows if row["rule"]["timeframe"] == "tick")
                price = next(row for row in rows if row["rule"]["kind"] == "price" and row["rule"]["timeframe"] == "M1")
                if tick["state"].get("quote_at", 0) > before[tick["id"]]["state"].get("quote_at", 0) and (
                        price["state"].get("last_event", 0) > before[price["id"]]["state"].get("last_event", 0)):
                    break
                time.sleep(1)
            else:
                raise AssertionError("persistent strategy demand did not advance new source observations")
            price = next(row for row in rows if row["rule"]["kind"] == "price" and row["rule"]["timeframe"] == "M1")
            binding, runtime = price["market_identity"], price["runtime"]
            page = web("GET", f"market-data/composites/{composite}/chart?timeframe=M1&count=1"
                f"&before={price['state']['previous']['start']+1}&revision_id={binding['composite_revision_id']}"
                f"&input_revision={runtime['processed_input_revision']}")
            bar = page["bars"][-1]
            assert all(Decimal(price["state"]["previous"][key]) == Decimal(bar[key]) for key in ("open", "high", "low", "close"))
            assert price["state"]["last_event"] == bar["end"]
            rpc_rows = call("alerts_list", {"limit": 100})["items"]
            witness = next(row for row in rpc_rows if row["id"] == price["id"])
            assert witness["market_identity"] == binding
            assert witness["runtime"]["confirmed_end"] >= runtime["confirmed_end"]
            report.update(passed=True, watches=rows, chart_strategy_price_parity=True,
                persistent_demand_advances_without_chart=True, mcp_http_fixed_identity_parity=True,
                fixed_revision_unchanged=True)
        finally:
            cancelled = []
            for ident in report["watch_ids"]:
                result = web("POST", "watches/" + ident + "/cancel", {})
                assert result["status"] in ("cancelled", "triggered")
                cancelled.append({"id": ident, "status": result["status"]})
            report["cleanup"] = cancelled
            args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"passed": report["passed"], "watches": len(report["watch_ids"]),
        "preparation_seconds": report.get("preparation_seconds")}))


if __name__ == "__main__":
    main()
