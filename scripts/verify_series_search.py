"""Real HTTP/MCP paginated search; short scoped credential revoked in finally."""

import json
import time
from pathlib import Path

import httpx
from alerts.mcp.auth import digest, issue, revoke
from alerts.storage import (
    MarketComposite,
    MarketDataset,
    MarketDemand,
    ProviderInterest,
    now_ms,
    transaction,
)
from sqlalchemy import func, select


def counts():
    with transaction() as db:
        return {t.__tablename__: db.scalar(select(func.count()).select_from(t))
                for t in (MarketComposite, MarketDataset, MarketDemand, ProviderInterest)}


def main():
    report = {"environment": "Ubuntu isolated market-watch-three-layer", "passed": False,
        "before": counts(), "pages": [], "checks": []}
    token = issue("series-search-acceptance", ["market:read"], now_ms() + 900000)
    try:
        with httpx.Client(base_url="http://127.0.0.1:8000", trust_env=False, timeout=60) as client:
            response = client.post("/api/login", json=json.loads(Path("artifacts/data-integration/three-layer-login.json").read_text()))
            response.raise_for_status()
            for kind, source, calendar in [("provider", "dukascopy", None), ("provider", "oanda", None),
                    ("history", None, None), ("history", "dukascopy", "ny17"),
                    ("history", "oanda", "utc0"), ("composite", None, None)]:
                offset, ids = 0, set()
                while True:
                    query = {"kind": kind, "page_size": 25, "offset": offset,
                        **({"source": source} if source else {}), **({"calendar": calendar} if calendar else {})}
                    started = time.monotonic()
                    page = client.get("/api/market-data/series/page", params=query)
                    page.raise_for_status()
                    elapsed = (time.monotonic() - started) * 1000
                    page = page.json()
                    for row in page["items"]:
                        assert row["id"] not in ids
                        ids.add(row["id"])
                        assert row["series_kind"] == kind
                        if source:
                            assert row.get("historical_source", row["source"]) == source
                        if calendar:
                            assert row["calendar"] == calendar
                    # Sample first/final page across all paths, rather than
                    # exceeding MCP call-rate limits on a full 1380 directory.
                    if offset == 0 or page["next_offset"] is None:
                        rpc = client.post("/mcp", headers={"Authorization": "Bearer " + token,
                            "Accept": "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25"},
                            json={"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                "params": {"name": "series_search", "arguments": query}})
                        rpc.raise_for_status()
                        answer = rpc.json()["result"]
                        assert not answer.get("isError"), answer
                        assert answer["structuredContent"] == page
                    report["pages"].append({"query": query, "items": len(page["items"]), "http_ms": round(elapsed, 3),
                        "has_more": page["has_more"], "next_offset": page["next_offset"]})
                    if page["next_offset"] is None:
                        if "total" in page:
                            assert len(ids) == page["total"]
                        break
                    assert page["next_offset"] > offset
                    offset = page["next_offset"]
            report["after"] = counts()
            # Expired provider interests can be removed by maintenance while
            # searching; reads must never increase collection demand.
            for name, amount in report["before"].items():
                assert report["after"][name] <= amount
            report["checks"] = ["actual supplier directory and fixed history/composite pages are reachable without duplicates",
                "source and day-phase filters preserve exact identities", "HTTP and scoped MCP first/final pages are identical",
                "no composite/dataset registration or collection demand created"]
            report["passed"] = True
    finally:
        revoke(digest(token))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
