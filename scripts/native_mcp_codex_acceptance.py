"""Run the installed Codex HTTP client and preserve its actual MCP tool trace."""

import argparse
import json
import os
import subprocess
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--url", default="https://localhost:18543/mcp")
parser.add_argument("--private-dir", default="/tmp/mw-native-mcp-acceptance")
parser.add_argument("--output", default="/tmp/native-mcp-codex-events.jsonl")
args = parser.parse_args()
root = Path(args.private_dir)
environment = os.environ.copy()
environment["MW_MCP_TOKEN"] = (root / "agent-read.token").read_text().strip()
environment["SSL_CERT_FILE"] = str(root / "ca-bundle.pem")
# Use a separate read-only credential and no workspace mutations.
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
    "Use only Market Watch MCP tools for the data. Read EURUSD managed H1 and H4 bars, optional Python indicators, alerts, "
    "and drawings in native-mcp-fixture. This is synthetic acceptance-fixture data, not live market data. "
    "Give a concise Chinese analysis distinguishing data facts, calculations and tentative price-structure interpretations, "
    "cite timestamps and price levels, and ask the user for their opinion at the end. Do not write alerts or execute trades. "
    "Do not use shell, browsing or other MCP servers.",
]
with Path(args.output).open("w") as output:
    result = subprocess.run(
        command, env=environment, stdout=output, stderr=subprocess.PIPE, text=True, timeout=240
    )
if result.returncode:
    raise SystemExit("Codex acceptance failed; inspect the private trace and client diagnostics")
events = [json.loads(line) for line in Path(args.output).read_text().splitlines() if line.strip()]
trace = [event for event in events if event.get("item", {}).get("type") == "mcp_tool_call"]
names = {event["item"].get("tool") for event in trace if event.get("type") == "item.completed"}
required = {"market_get_bars", "charts_get_drawings", "alerts_list"}
if not required <= names:
    raise SystemExit(
        "Codex did not demonstrate all required MCP tools; inspect actual event schema and trace"
    )
print("Codex MCP calls verified; inspect cited analysis and question in:", args.output)
