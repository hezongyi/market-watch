"""Real supplier/native API parity; no managed datasets or live demand created.

Run inside the isolated api container, where provider credentials already live.
Prints public prices and hashed identities only; never prints login or account.
"""

import json
import time
from decimal import Decimal
from pathlib import Path

import httpx
from alerts import provider_cache, provider_chart
from alerts.config import settings
from alerts.native_series import DEFAULTS, chart_label, interval_end
from alerts.storage import MarketDemand, ProviderInterest, SourceSeries, transaction
from sqlalchemy import func, select


def counts():
    with transaction() as db:
        return {table.__tablename__: db.scalar(select(func.count()).select_from(table))
            for table in (MarketDemand, ProviderInterest, SourceSeries)}


def main():
    report = {"environment": "Ubuntu isolated market-watch-three-layer", "passed": False,
        "before": counts(), "checks": [], "pages": []}
    with httpx.Client(base_url="http://127.0.0.1:8000", timeout=60, trust_env=False) as client:
        login = client.post("/api/login", json=json.loads(Path("artifacts/data-integration/three-layer-login.json").read_text()))
        login.raise_for_status()
        client.headers["X-CSRF-Token"] = login.json()["csrf"]

        def post(route, body):
            response = client.post("/api/" + route, json=body)
            response.raise_for_status()
            return response.json()

        configs = [DEFAULTS, {**DEFAULTS, "price": "A"},
            {**DEFAULTS, "price": "M", "smooth": True, "dailyAlignment": 0,
                "alignmentTimezone": "UTC", "weeklyAlignment": "Monday"},
            {**DEFAULTS, "price": "M", "dailyAlignment": 8, "alignmentTimezone": "Europe/London",
                "weeklyAlignment": "Friday"}]
        before = 1790812800000  # 2026-10-01 UTC; fixed historical observations.
        keys = set()
        for values in configs:
            registered = post("charts/provider/configure", {"instrument": "OANDA:EUR_USD", "parameters": values})
            assert registered == post("charts/provider/configure", {"instrument": "OANDA:EUR_USD", "parameters": values})
            ident, meta = registered["ticker"][4:], registered["metadata"]
            assert json.loads(json.dumps(provider_chart.metadata(ident))) == meta
            frames = provider_chart.FRAMES if values == configs[2] else ("H4", "D1", "W1", "MN")
            for frame in frames:
                query = {"instrument": ident, "series_kind": "provider", "timeframe": frame, "before": before, "limit": 4}
                page = post("charts/data", query)
                repeated = post("charts/data", query)
                assert repeated["cache_hit"] and repeated["bars"] == page["bars"]
                assert page["native_parameters"] == values
                assert len(page["bars"]) == 4
                key = provider_cache.identity(meta, frame)
                assert key == page["dataset_id"] and key not in keys
                keys.add(key)
                payload = provider_chart._request(provider_chart.pooled_client("oanda"),
                    "https://api-fxpractice.oanda.com/v3/instruments/EUR_USD/candles",
                    params={**values, "smooth": str(values["smooth"]).lower(),
                        "granularity": provider_chart.OANDA_FRAMES[frame], "count": 10,
                        "to": str(Decimal(page["bars"][-1]["start"] + 60000) / 1000)},
                    headers={"Authorization": "Bearer " + settings.oanda_token, "Accept-Datetime-Format": "UNIX"},
                    deadline=time.monotonic() + 23)
                original = {int(Decimal(c["time"]) * 1000): c for c in payload["candles"]}
                for bar in page["bars"]:
                    candle = original[bar["start"]]
                    prices = candle[{"B": "bid", "A": "ask", "M": "mid"}[values["price"]]]
                    for key_name, field in (("open", "o"), ("high", "h"), ("low", "l"), ("close", "c")):
                        assert Decimal(bar[key_name]) == Decimal(prices[field])
                    assert bar["complete"] == candle["complete"]
                    assert Decimal(bar["volume"]) == Decimal(candle["volume"])
                    assert bar["chart_time"] == chart_label(bar["start"], frame, values) < before
                    assert bar["end"] == interval_end(bar["start"], frame, values)
                older = post("charts/data", {**query, "before": page["bars"][0]["chart_time"]})
                assert older["bars"][-1]["chart_time"] < page["bars"][0]["chart_time"]
                report["pages"].append({"parameters": values, "frame": frame, "dataset_id": key,
                    "bars": page["bars"], "cache_reused": True, "exclusive_older_page": True})
        report["after"] = counts()
        for table in (MarketDemand.__tablename__, ProviderInterest.__tablename__):
            assert report["before"][table] == report["after"][table]
        report["checks"] = ["four native configurations remain immutable and idempotent",
            "nine UTC0 Mid smoothed periods and three additional H4/D1/W1/MN configurations match original supplier OHLC and volume",
            "every configuration has isolated durable cache and exclusive backward pagination",
            "configuration and API-only history reads create no live demand"]
        report["passed"] = True
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
