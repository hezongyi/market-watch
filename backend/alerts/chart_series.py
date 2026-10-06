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
    if re.fullmatch(r"YAHOO:[A-Fa-f0-9]{32}", symbol):
        symbol = "YAHOO:" + symbol[6:].lower()
    return symbol, kind


def encode(symbol: str, kind: SeriesKind = "managed") -> str:
    if kind not in ("provider", "managed") or decode(symbol)[1] != "managed":
        raise ValueError("无效行情系列或基础品种")
    canonical = decode(symbol)[0]
    return PROVIDER_PREFIX + canonical if kind == "provider" else canonical


def display_symbol(symbol: str) -> str:
    """A compact UI code; provider routing always retains the original ticker."""
    return symbol.rsplit(":", 1)[-1].replace("_", "").replace("/", "").upper()


def is_gold(symbol: str) -> bool:
    return display_symbol(symbol) == "XAUUSD"
