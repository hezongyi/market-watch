"""Run installed Codex and verify successful, evidence-bearing HTTP MCP calls."""

import argparse
import json
import os
import subprocess
from pathlib import Path


def verify_trace(events):
    if not any(event.get("type") == "turn.completed" for event in events):
        raise ValueError("Codex has no completed turn evidence")
    completed = [
        event["item"]
        for event in events
        if event.get("type") == "item.completed"
        and event.get("item", {}).get("type") == "mcp_tool_call"
    ]
    calls = []
    for item in completed:
        if item.get("server") != "market_watch":
            raise ValueError("Codex used an unrelated MCP server")
        if item.get("status") != "completed" or item.get("error") is not None:
            raise ValueError("Codex MCP call failed")
        result = item.get("result")
        if not isinstance(result, dict) or result.get("isError") or result.get("is_error"):
            raise ValueError("Codex call returned a tool error or no result")
        data = result.get("structured_content", result.get("structuredContent"))
        if not isinstance(data, dict):
            # Some CLI versions preserve the SDK text content only.
            contents = result.get("content", [])
            texts = [part.get("text", "") for part in contents if part.get("type") == "text"]
            try:
                data = json.loads("\n".join(texts))
            except (TypeError, ValueError):
                raise ValueError("Codex tool result is not structured data") from None
        if "error" in data:
            raise ValueError("Codex tool reported a business error")
        calls.append({"tool": item.get("tool"), "arguments": item.get("arguments"), "data": data})
    required = {"market_get_bars", "charts_get_drawings", "alerts_list", "indicators_calculate"}
    if not required <= {call["tool"] for call in calls}:
        raise ValueError("Codex did not successfully call all required tools")
    if any(
        call["tool"] in {"alerts_create", "alerts_cancel", "notifications_ack"}
        or str(call["tool"]).startswith("trading_")
        for call in calls
    ):
        raise ValueError("Codex attempted a write or trading action")
    market_calls = [call for call in calls if call["tool"] == "market_get_bars"]
    frames = {
        call["data"].get("timeframe")
        for call in market_calls
        if call["data"].get("instrument") == "EURUSD"
        and call["data"].get("series_kind") == "managed"
        and call["data"].get("page", {}).get("bars")
    }
    if not {"H1", "H4"} <= frames:
        raise ValueError("Codex did not read both EURUSD H1/H4 candles")
    if not any(
        call["tool"] == "indicators_calculate" and call["data"].get("page", {}).get("indicators")
        for call in calls
    ):
        raise ValueError("Codex has no backend indicator evidence")
    drawing_data = [call["data"] for call in calls if call["tool"] == "charts_get_drawings"]
    if not any(
        data.get("workspace_id") == "native-mcp-fixture"
        and data.get("charts")
        and data.get("visibility") == "saved_only"
        for data in drawing_data
    ):
        raise ValueError("Codex did not read saved drawing evidence")
    messages = [
        event["item"].get("text", "")
        for event in events
        if event.get("type") == "item.completed"
        and event.get("item", {}).get("type") == "agent_message"
    ]
    if not messages or not any(mark in messages[-1] for mark in ("?", "？")):
        raise ValueError("Codex final analysis does not ask the user for their opinion")
    if any(event.get("type") in {"error", "turn.failed"} for event in events):
        raise ValueError("Codex turn did not finish successfully")
    return {
        "successful_tools": sorted({call["tool"] for call in calls}),
        "timeframes": sorted(frames),
        "analysis": messages[-1],
    }


def main(args):
    root = Path(args.private_dir)
    environment = os.environ.copy()
    environment["MW_MCP_TOKEN"] = (root / "agent-read.token").read_text().strip()
    environment["SSL_CERT_FILE"] = str(root / "ca-bundle.pem")
    environment["CODEX_CA_CERTIFICATE"] = str(root / "ca-bundle.pem")
    command = [
        "codex",
        "exec",
        "--ephemeral",
        "--json",
        "--sandbox",
        "read-only",
        "-c",
        "mcp_servers.market_watch.url=" + json.dumps(args.url),
        "-c",
        'mcp_servers.market_watch.bearer_token_env_var="MW_MCP_TOKEN"',
        "-c",
        "mcp_servers.market_watch.tool_timeout_sec=30",
        "-c",
        "mcp_servers.market_watch.startup_timeout_sec=30",
        "Use only Market Watch MCP tools for the data. Call market_get_bars for EURUSD managed H1 and H4 separately with limit 30, "
        "Call indicators_calculate for at least one backend indicator (EMA period 10), alerts_list, "
        "and charts_get_drawings in native-mcp-fixture. Do not calculate indicators mentally; "
        "quote exact indicator values only from the backend tool. "
        "This is synthetic acceptance-fixture data, not live market data. Give a concise Chinese analysis distinguishing "
        "data facts, calculations and tentative price-structure interpretations, cite timestamps and price levels, "
        "and ask the user for their opinion at the end. Do not write alerts or execute trades. "
        "Do not use shell, browsing or other MCP servers. Do not read additional stdin.",
    ]
    output = Path(args.output)
    # Client errors are needed to diagnose transport/TLS failures; keep them private.
    diagnostics = output.with_suffix(".stderr.log")
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    err_fd = os.open(diagnostics, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.chmod(output, 0o600)
    os.chmod(diagnostics, 0o600)
    with os.fdopen(fd, "w") as stream, os.fdopen(err_fd, "w") as errors:
        result = subprocess.run(
            command,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=stream,
            stderr=errors,
            text=True,
            timeout=240,
        )
    if result.returncode:
        raise SystemExit("Codex acceptance failed; inspect private trace and client diagnostics")
    events = [json.loads(line) for line in output.read_text().splitlines() if line.strip()]
    checked = verify_trace(events)
    print("Codex successful MCP calls:", ", ".join(checked["successful_tools"]))
    print("Review timestamp/price citations and interpretation in:", output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="https://localhost:18543/mcp")
    parser.add_argument("--private-dir", default="/tmp/mw-native-mcp-acceptance")
    parser.add_argument("--output", default="/tmp/native-mcp-codex-events.jsonl")
    main(parser.parse_args())
