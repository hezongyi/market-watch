"""Explicit read-only upstream acceptance; not collected by pytest.

Run with PYTHONPATH=backend .venv/bin/python backend/tests/verify_provider_live.py.
Loads only upstream settings from the restricted local env file. No DB or notices.
"""

import argparse
import json
import os
import time
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="/tmp/mw-provider-live.json")
    parser.add_argument("--samples", type=int, default=1)
    args = parser.parse_args()
    allowed = {"ALERTS_OANDA_TOKEN", "ALERTS_OANDA_ACCOUNT_ID", "ALERTS_OANDA_PROXY", "ALERTS_BINANCE_PROXY"}
    for line in Path("/tmp/mw-docker-acceptance/api.env").read_text().splitlines():
        key, sep, value = line.partition("=")
        if sep and key in allowed:
            os.environ[key] = value
    from alerts import provider_chart as provider
    from alerts.providers import fetch_oanda_catalog
    from alerts.storage import now_ms

    catalog = {item["name"]: item for item in fetch_oanda_catalog()}
    metas = []
    for ident, symbol in (("EURUSD", "EUR_USD"), ("XAUUSD", "XAU_USD"), ("OANDA:EUR_CHF", "EUR_CHF")):
        if symbol not in catalog:
            raise RuntimeError("验收品种不在当前账户目录中")
        metas.append({"id": ident, "symbol": symbol, "source": "oanda", "basis": "bid",
                      "calendar": "ny17", "precision": catalog[symbol]["displayPrecision"]})
    metas.append({"id": "BTCUSDT", "symbol": "BTCUSDT", "source": "binance", "basis": "last", "calendar": "utc0", "precision": 2})
    results = []
    for meta in metas:
        for frame in provider.FRAMES:
            for sample in range(args.samples):
                provider._CACHE.clear()
                before = now_ms() // 1000 * 1000
                started = time.monotonic()
                try:
                    page = provider.cached_page(meta, frame, before, 20)
                    cold = (time.monotonic() - started) * 1000
                    started = time.monotonic()
                    hot = provider.cached_page(meta, frame, before, 20)
                    hot_ms = (time.monotonic() - started) * 1000
                    assert page["bars"] and page == hot
                    assert all(b["chart_time"] < before for b in page["bars"])
                    assert all(a["chart_time"] < b["chart_time"] for a, b in zip(page["bars"], page["bars"][1:]))
                    assert all(b["end"] > b["start"] for b in page["bars"])
                    if frame == "MN":
                        assert all(28 * 86400000 - 3600000 <= b["end"] - b["start"] <= 31 * 86400000 + 3600000 for b in page["bars"])
                    result = {"instrument": meta["id"], "source": meta["source"], "frame": frame,
                              "sample": sample, "cold_ms": round(cold, 2), "hot_ms": round(hot_ms, 2),
                              "count": len(page["bars"]), "bars": page["bars"], "passed": True}
                except Exception as error:
                    # Do not serialize request headers, environment, or upstream error bodies.
                    result = {"instrument": meta["id"], "frame": frame, "sample": sample,
                              "passed": False, "error_type": type(error).__name__}
                results.append(result)
                Path(args.output).write_text(json.dumps({"observed_at": now_ms(), "results": results}, indent=2))
                print(json.dumps({k: v for k, v in result.items() if k != "bars"}), flush=True)
    if not all(r["passed"] for r in results):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
