"""Actual stored/sample quote parity and exact owned chart-lease cleanup.

Run HTTP checks on Ubuntu; run ``release`` inside its isolated API container.
Reports contain source prices and opaque identities, never authentication data.
"""

import argparse
import hashlib
import json
import time
from decimal import Decimal
from pathlib import Path

import httpx

CLIENT = "acceptance-composite-quotes"


def comparable(value):
    return {key: item for key, item in value.items() if key != "queried_at"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("stored", "sampled", "release"))
    parser.add_argument("--composite", required=True)
    parser.add_argument("--base", default="http://127.0.0.1:16629")
    parser.add_argument("--token", type=Path, default=Path("artifacts/data-integration/three-layer-maintenance-20261007.token"))
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report = {"environment": "Ubuntu isolated market-watch-three-layer", "action": args.action,
              "composite_id": args.composite, "passed": False}
    if args.action == "release":
        from alerts.storage import MarketComposite, MarketDemand, transaction

        with transaction() as db:
            composite = db.get(MarketComposite, args.composite)
            assert composite is not None
            ident = hashlib.sha256((CLIENT + "|" + composite.instrument_id).encode()).hexdigest()[:40]
            demand = db.get(MarketDemand, ident)
            assert demand is None or demand.instrument_id == composite.instrument_id
            if demand:
                db.delete(demand)
        report.update(passed=True, released_client=CLIENT, released_lease=ident)
    else:
        with httpx.Client(base_url=args.base, timeout=45, trust_env=False) as client:
            login = client.post("/api/login", json=json.loads(Path("artifacts/data-integration/three-layer-login.json").read_text()))
            login.raise_for_status()
            client.headers["X-CSRF-Token"] = login.json()["csrf"]

            def get(path):
                response = client.get("/api/market-data/" + path)
                response.raise_for_status()
                return response.json()

            def post(path, body):
                response = client.post("/api/market-data/" + path, json=body)
                response.raise_for_status()
                return response.json()

            def counts():
                return [(row["id"], row["usage"]) for row in get("center/composites?page_size=100")["items"]]

            quote_path = f"composites/{args.composite}/quote"
            if args.action == "sampled":
                post("activity", {"client": CLIENT, "instrument": "MWC:" + args.composite})
                start = last_renewal = time.monotonic()
                while time.monotonic() - start < 110:
                    quote = get(quote_path)
                    if quote["quote_ready"]:
                        break
                    if time.monotonic() - last_renewal > 30:
                        post("activity", {"client": CLIENT, "instrument": "MWC:" + args.composite})
                        last_renewal = time.monotonic()
                    time.sleep(1)
                assert quote["quote_ready"], quote
            before = counts()
            quote = get(quote_path)
            assert quote["price_type"] == ("sampled_bid" if args.action == "sampled" else "confirmed_m1_close"), quote
            assert quote["quality"] == ("sampled" if args.action == "sampled" else "stored"), quote
            assert Decimal(quote["price"]).is_finite() and Decimal(quote["price"]) > 0
            if args.action == "sampled":
                evidence = quote["provenance"]
                assert quote["price"] == evidence["quote"]["bid"]
                assert quote["observed_at"] == evidence["quote"]["source_time"] >= quote["seam"]
                assert evidence["quote"]["connection_epoch"] == evidence["connection_epoch"]
                assert 0 <= quote["queried_at"] - quote["observed_at"] <= 15000
            else:
                assert not quote["quote_ready"]
                page = get(f"composites/{args.composite}/chart?timeframe=M1&count=1"
                    f"&before={quote['queried_at']//60000*60000}&revision_id={quote['revision_id']}"
                    f"&input_revision={quote['input_revision']}")
                bar = page["bars"][-1]
                assert bar["source_confirmed"] and bar["time_closed"]
                assert (bar["close"], bar["end"], bar["segments"]) == (
                    quote["price"], quote["observed_at"], quote["provenance"]["segments"])
                report["stored_chart_parity"] = True
            watchlist = post("quotes", {"symbols": ["MWC:" + args.composite], "client": CLIENT})[0]
            assert watchlist["s"] == "ok" and watchlist["v"]["price_type"] == quote["price_type"]
            assert watchlist["v"]["lp"] == float(watchlist["snapshot"]["price"])
            assert "ch" not in watchlist["v"] and "chp" not in watchlist["v"]
            assert watchlist["v"]["quote_time"] == watchlist["snapshot"]["observed_at"]
            assert watchlist["snapshot"]["revision_id"] == quote["revision_id"]
            assert "UTC" in watchlist["v"]["description"]
            # Sequential live reads can straddle a tick; require an actual same
            # observation witness rather than equating different source quotes.
            for _ in range(30):
                response = client.post("/mcp", headers={"Authorization": "Bearer " + args.token.read_text().strip(),
                    "Accept": "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25"},
                    json={"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
                        "name": "composite_get_quote", "arguments": {"composite_id": args.composite}}})
                response.raise_for_status()
                result = response.json()["result"]
                assert not result.get("isError"), result
                browser = get(quote_path)
                if comparable(result["structuredContent"]) == comparable(browser):
                    report["mcp_http_parity"] = True
                    break
                time.sleep(.1)
            assert report.get("mcp_http_parity"), "no identical HTTP/MCP source observation"
            assert counts() == before, "quote reads changed definitions or live demand"
            report.update(snapshot=quote, watchlist=watchlist, quote_reads_preserve_demand=True, passed=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"action": args.action, "passed": report["passed"]}))


if __name__ == "__main__":
    main()
