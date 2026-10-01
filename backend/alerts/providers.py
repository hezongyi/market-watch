"""Public market-only Binance adapter. Quotes and historical candles use one market."""

from datetime import datetime

import httpx

from .config import settings
from .market_resources import request_slot
from .storage import now_ms


def fetch_binance(symbol="BTCUSDT", start=None, end=None, mode="live", client=None):
    if symbol != "BTCUSDT":
        raise ValueError("Unsupported Binance market")
    base = "https://data-api.binance.vision/api/v3"
    owns = client is None
    client = client or httpx.Client(timeout=15, proxy=settings.effective_binance_proxy or None, trust_env=False)
    try:
        if mode == "quote":
            with request_slot("binance"):
                response = client.get(base + "/trades", params={"symbol": symbol, "limit": 100})
            response.raise_for_status()
            data = response.json()
            return {
                "rows": [
                    {"timestamp": r["time"], "bidPrice": r["price"], "askPrice": r["price"]}
                    for r in data
                ],
                "source": "binance",
                "basis": "last",
            }
        left = (
            int(datetime.fromisoformat(start.replace("Z", "+00:00")).timestamp() * 1000)
            if start
            else now_ms() - 120 * 60_000
        )
        right = (
            int(datetime.fromisoformat(end.replace("Z", "+00:00")).timestamp() * 1000)
            if end
            else now_ms()
        )
        cursor = left
        rows = []
        while cursor < right:
            with request_slot("binance"):
                response = client.get(
                    base + "/klines",
                params={
                    "symbol": symbol,
                    "interval": "1m",
                    "startTime": cursor,
                    "endTime": right - 1,
                    "limit": 1000,
                },
            )
            response.raise_for_status()
            batch = response.json()
            if not isinstance(batch, list):
                raise ValueError("Invalid exchange response")
            if not batch:
                break
            for r in batch:
                if left <= r[0] < right:
                    rows.append(
                        {"timestamp": r[0], "open": r[1], "high": r[2], "low": r[3], "close": r[4]}
                    )
            next_cursor = int(batch[-1][0]) + 60_000
            if next_cursor <= cursor:
                raise ValueError("Provider cursor did not advance")
            cursor = next_cursor
            if len(batch) < 1000:
                break
        return {
            "source": "binance",
            "basis": "last",
            "instrument": symbol,
            "rows": rows,
            "window_start": left,
            "window_end": right,
            "coverage": [
                {
                    "start": left,
                    "end": min(right, (now_ms() - 5000) // 60000 * 60000),
                    "returned": len(rows),
                }
            ],
        }
    finally:
        if owns:
            client.close()


def fetch_oanda(symbol, start=None, end=None, mode="live", client=None):
    """Read-only practice API; aggregate only source M1 locally."""
    import re

    if not re.fullmatch(r"[A-Z0-9]+(?:_[A-Z0-9]+)+", symbol):
        raise ValueError("Invalid OANDA instrument")
    if not settings.oanda_token:
        raise ValueError("OANDA token is not configured")
    owns = client is None
    client = client or httpx.Client(timeout=15, proxy=settings.oanda_proxy or None, trust_env=False)
    base = "https://api-fxpractice.oanda.com/v3"
    headers = {"Authorization": "Bearer " + settings.oanda_token, "Accept-Datetime-Format": "UNIX"}
    from decimal import Decimal

    def timestamp(value):
        return int(Decimal(value) * 1000)

    def request(path, params):
        import time

        for attempt in range(3):
            try:
                with request_slot("oanda"):
                    response = client.get(base + path, params=params, headers=headers)
                if response.status_code not in {502, 503, 504} or attempt == 2:
                    response.raise_for_status()
                    return response
            except (httpx.ConnectError, httpx.TimeoutException):
                if attempt == 2:
                    raise
            time.sleep(0.5 * (2**attempt))
        raise RuntimeError("OANDA request retry exhausted")

    try:
        if mode == "quote":
            response = request(
                f"/accounts/{settings.oanda_account_id}/pricing", {"instruments": symbol}
            )
            response.raise_for_status()
            return {
                "source": "oanda",
                "basis": "bid",
                "rows": [
                    {
                        "timestamp": timestamp(p["time"]),
                        "bidPrice": p["bids"][0]["price"],
                        "askPrice": p["asks"][0]["price"],
                    }
                    for p in response.json()["prices"]
                    if p.get("tradeable") and p.get("bids") and p.get("asks")
                ],
            }
        left = (
            int(datetime.fromisoformat(start.replace("Z", "+00:00")).timestamp() * 1000)
            if start
            else now_ms() - 120 * 60000
        )
        right = (
            int(datetime.fromisoformat(end.replace("Z", "+00:00")).timestamp() * 1000)
            if end
            else now_ms()
        )
        cursor = left
        rows = []
        coverage = []
        while cursor < right:
            stop = min(right, cursor + 4000 * 60000)
            response = request(
                f"/instruments/{symbol}/candles",
                params={
                    "granularity": "M1",
                    "price": "B",
                    "smooth": "false",
                    "from": str(Decimal(cursor) / 1000),
                    "to": str(Decimal(stop) / 1000),
                },
            )
            response.raise_for_status()
            for candle in response.json()["candles"]:
                at = timestamp(candle["time"])
                if candle["complete"] and left <= at < right:
                    prices = candle["bid"]
                    rows.append(
                        {
                            "timestamp": at,
                            **{
                                k: prices[v]
                                for k, v in [
                                    ("open", "o"),
                                    ("high", "h"),
                                    ("low", "l"),
                                    ("close", "c"),
                                ]
                            },
                        }
                    )
            coverage.append(
                {
                    "start": cursor,
                    "end": min(
                        [stop]
                        + [
                            timestamp(c["time"])
                            for c in response.json()["candles"]
                            if not c["complete"]
                        ]
                    ),
                    "returned": len(response.json()["candles"]),
                    "request_id": response.headers.get("RequestID"),
                }
            )
            cursor = stop
        return {
            "source": "oanda",
            "basis": "bid",
            "instrument": symbol,
            "rows": rows,
            "coverage": coverage,
            "window_start": left,
            "window_end": right,
        }
    finally:
        if owns:
            client.close()


def fetch_oanda_catalog(client=None):
    """Account-specific tradable metadata. Never exposes credentials to clients."""
    owns = client is None
    client = client or httpx.Client(timeout=15, proxy=settings.oanda_proxy or None, trust_env=False)
    try:
        response = client.get(
            f"https://api-fxpractice.oanda.com/v3/accounts/{settings.oanda_account_id}/instruments",
            headers={"Authorization": "Bearer " + settings.oanda_token},
        )
        response.raise_for_status()
        return response.json()["instruments"]
    finally:
        if owns:
            client.close()
