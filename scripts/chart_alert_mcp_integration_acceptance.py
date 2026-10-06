"""Check chart-alert events through deployed HTTP MCP and authenticated browser API."""

import argparse
import json
import uuid
from pathlib import Path

import httpx

ROOT = Path("/tmp/mw-chart-alerts-integration")
APP = "https://localhost:19543"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default=str(ROOT / "combined-mcp.json"))
    args = parser.parse_args()
    report = {
        "scope": "actual combined Ubuntu Docker HTTPS API/MCP, synthetic task event evidence",
        "cases": [],
        "external_notifications_sent": False,
    }
    write = (ROOT / "agent.token").read_text().strip()
    read = (ROOT / "agent-read.token").read_text().strip()
    with httpx.Client(
        base_url=APP, verify=str(ROOT / "cert.pem"), trust_env=False, timeout=45
    ) as browser:
        response = browser.post("/api/login", json=json.loads((ROOT / "login.json").read_text()))
        response.raise_for_status()
        browser.headers["X-CSRF-Token"] = response.json()["csrf"]

        def rpc(token, name, arguments):
            r = browser.post(
                "/mcp",
                headers={
                    "Authorization": "Bearer " + token,
                    "Accept": "application/json, text/event-stream",
                    "MCP-Protocol-Version": "2025-11-25",
                },
                json={
                    "jsonrpc": "2.0",
                    "id": uuid.uuid4().hex,
                    "method": "tools/call",
                    "params": {"name": name, "arguments": arguments},
                },
            )
            r.raise_for_status()
            return r.json()["result"]

        result = rpc(read, "alerts_get_signals", {})
        assert not result.get("isError"), result
        signals = result["structuredContent"]["items"]
        chart = [r for r in signals if r.get("chart_alert_id")]
        assert chart, "Run runtime/fault acceptance first to generate actual worker events"
        browser_signals = browser.get("/api/signals").json()
        assert signals == browser_signals
        assert all(r["watch_id"] is None and r["evidence"]["chart_alert"] for r in chart)
        report["cases"].append(
            "MCP and browser return identical chart and legacy events without requiring legacy watch IDs"
        )
        note = next(r for r in chart if r["notification_status"] != "acknowledged")
        alert_id = note["chart_alert_id"]
        before = browser.get("/api/chart-alerts/" + alert_id).json()
        others = {
            r["id"]: r["notification_status"] for r in browser_signals if r["id"] != note["id"]
        }
        ack_args = {
            "idempotency_key": "combined-ack-" + uuid.uuid4().hex,
            "notification_id": note["notification_id"],
        }
        denied = rpc(read, "notifications_ack", ack_args)
        assert denied.get("isError"), "read-only MCP must reject a write"
        assert browser.get("/api/signals").json() == browser_signals
        report["cases"].append(
            "read-only MCP denies acknowledgement and leaves all event records unchanged"
        )
        accepted = rpc(write, "notifications_ack", ack_args)
        assert not accepted.get("isError"), accepted
        assert rpc(write, "notifications_ack", ack_args) == accepted
        after = browser.get("/api/signals").json()
        assert (
            next(r for r in after if r["id"] == note["id"])["notification_status"] == "acknowledged"
        )
        assert {r["id"]: r["notification_status"] for r in after if r["id"] != note["id"]} == others
        current = browser.get("/api/chart-alerts/" + alert_id).json()
        assert (current["count"], current["run"], current["version"], current["status"]) == (
            before["count"],
            before["run"],
            before["version"],
            before["status"],
        )
        report["cases"].append(
            "authorized MCP acknowledges one chart event idempotently without changing other events or rule count/run/version"
        )
        report.update(
            verified=True,
            chart_event_count=len(chart),
            legacy_event_count=len(signals) - len(chart),
        )
        Path(args.output).write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report))


if __name__ == "__main__":
    main()
