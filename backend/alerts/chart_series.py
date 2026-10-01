"""Chart identity. Bare legacy tickers permanently mean managed data."""

import re
from typing import Literal

SeriesKind = Literal["provider", "managed"]
PROVIDER_PREFIX = "MWP:"


def decode(ticker: str) -> tuple[str, SeriesKind]:
    if not isinstance(ticker, str):
        raise ValueError("无效行情标识")
    kind = "provider" if ticker.startswith(PROVIDER_PREFIX) else "managed"
    symbol = ticker[len(PROVIDER_PREFIX) :] if kind == "provider" else ticker
    if not re.fullmatch(r"[A-Za-z0-9:_-]{1,40}", symbol):
        raise ValueError("无效品种标识")
    return symbol, kind


def encode(symbol: str, kind: SeriesKind = "managed") -> str:
    if kind not in ("provider", "managed") or decode(symbol)[1] != "managed":
        raise ValueError("无效行情系列或基础品种")
    return PROVIDER_PREFIX + symbol if kind == "provider" else symbol
