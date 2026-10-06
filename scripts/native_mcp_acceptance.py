"""Real HTTPS SDK protocol and browser adapter parity against local Compose."""

import argparse
import asyncio
import json
import ssl
import uuid
from pathlib import Path

import httpx
import httpx2
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client


async def main(args):
    root = Path(args.private_dir)
    token = (root / "agent.token").read_text().strip()
    tls = ssl.create_default_context(cafile=str(root / "cert.pem"))
    with httpx.Client(base_url=args.url, verify=tls, trust_env=False) as browser:
        response = browser.post("/api/login", json=json.loads((root / "login.json").read_text()))
        response.raise_for_status()
        csrf = response.json()["csrf"]
        browser.headers["X-CSRF-Token"] = csrf
        web_quote = next(
            row for row in browser.get("/api/instruments").json() if row["id"] == "EURUSD"
        )
        params = {
            "instrument": "EURUSD",
            "timeframe": "H1",
            "limit": 30,
            "indicators": [{"name": "EMA", "params": {"period": 10}}, {"name": "RSI"}],
        }
        web_page = browser.post("/api/charts/data", json={**params, "track_history": True}).json()
        assert browser.post("/mcp", json={}).status_code == 401
        assert (
            browser.post("/mcp", headers={"Authorization": "Bearer invalid"}, json={}).status_code
            == 401
        )
        before = browser.get("/api/watches").json()
        report = {
            "url": args.url + "/mcp",
            "transport": "Streamable HTTP over HTTPS",
            "source": "acceptance-fixture",
            "synthetic_market_data": True,
            "checks": [],
            "versions": {},
        }
        import importlib.metadata

        for package in ("mcp", "fastapi", "starlette", "pydantic"):
            report["versions"][package] = importlib.metadata.version(package)
        async with httpx2.AsyncClient(
            verify=tls, trust_env=False, headers={"Authorization": "Bearer " + token}
        ) as http:
            async with streamable_http_client(args.url + "/mcp", http_client=http) as streams:
                async with ClientSession(streams[0], streams[1]) as session:
                    initialized = await session.initialize()
                    report["protocol_version"] = initialized.protocol_version
                    tools = await session.list_tools()
                    names = [tool.name for tool in tools.tools]
                    assert len(names) == 13, names
                    report["tools"] = names
                    report["checks"] += [
                        "initialize",
                        "tools/list",
                        "schema discovery",
                        "authentication rejection",
                    ]

                    async def call(name, arguments):
                        result = await session.call_tool(name, arguments)
                        assert not result.is_error, result.content
                        assert isinstance(result.structured_content, dict)
                        return result.structured_content

                    quoted = await call("market_get_quote", {"instrument": "EURUSD"})
                    assert (quoted["price"], quoted["price_type"], quoted["quality"]) == (
                        web_quote["price"],
                        web_quote["price_type"],
                        web_quote["quality"],
                    )
                    result = await call("indicators_calculate", params)
                    page = result["page"]
                    assert page["bars"] == web_page["bars"]
                    assert page["indicators"] == web_page["indicators"]
                    assert page["history_revision"] == web_page["history_revision"]
                    report["checks"] += [
                        "web/MCP quote parity",
                        "web/MCP OHLC parity",
                        "web/MCP indicator parity",
                        "revision parity",
                    ]
                    report["sample"] = {
                        "quote": quoted,
                        "range": [page["bars"][0]["start"], page["bars"][-1]["end"]],
                        "history_revision": page["history_revision"],
                    }
                    saved = await call(
                        "charts_get_drawings", {"workspace_id": "native-mcp-fixture"}
                    )
                    assert saved["visibility"] == "saved_only"
                    assert saved["charts"][0]["drawings"][0]["supported"]
                    assert not saved["charts"][0]["drawings"][1]["supported"]
                    report["checks"] += ["saved projection", "unknown drawing rejection"]
                    body = {
                        "idempotency_key": "https-create-fixture",
                        "watch": {
                            "instrument_id": "EURUSD",
                            "name": "MCP HTTPS acceptance",
                            "kind": "price",
                            "level": "1.20",
                            "use_history": False,
                        },
                    }
                    body["idempotency_key"] = "https-concurrent-" + uuid.uuid4().hex
                    concurrent = await asyncio.gather(
                        *(call("alerts_create", body) for _ in range(4))
                    )
                    created = concurrent[0]
                    assert all(item == created for item in concurrent)
                    repeated = await call("alerts_create", body)
                    assert created == repeated
                    conflict = await session.call_tool(
                        "alerts_create", {**body, "watch": {**body["watch"], "level": "1.30"}}
                    )
                    assert (
                        conflict.is_error
                        and conflict.structured_content["error"]["code"] == "IDEMPOTENCY_CONFLICT"
                    )
                    acknowledged = await call(
                        "notifications_ack",
                        {
                            "idempotency_key": "https-ack-fixture",
                            "notification_id": "native-mcp-note-fixture",
                        },
                    )
                    assert acknowledged["status"] == "acknowledged"
                    assert acknowledged == await call(
                        "notifications_ack",
                        {
                            "idempotency_key": "https-ack-fixture",
                            "notification_id": "native-mcp-note-fixture",
                        },
                    )
                    report["checks"] += ["concurrent first create", "notification ack retry"]
                    cancelled = await call(
                        "alerts_cancel",
                        {"idempotency_key": "https-cancel-fixture", "watch_id": created["id"]},
                    )
                    assert cancelled["status"] == "cancelled"
                    report["checks"] += [
                        "idempotent create retry",
                        "same-key intent conflict",
                        "cancel",
                    ]
        after = browser.get("/api/watches").json()
        matching = [row for row in after if row["id"] == created["id"]]
        assert len(matching) == 1 and matching[0]["status"] == "cancelled"
        report["alert_count_before"] = len(before)
        report["alert_count_after"] = len(after)
        Path(args.output).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        print("HTTPS MCP acceptance passed; report:", args.output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="https://localhost:18543")
    parser.add_argument("--private-dir", default="/tmp/mw-native-mcp-acceptance")
    parser.add_argument("--output", default="/tmp/native-mcp-https-report.json")
    asyncio.run(main(parser.parse_args()))
