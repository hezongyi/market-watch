"""The native provider differences shared by readers, workers and transport."""

import hashlib
import json

from .chart_data import FRAMES
from .config import settings

SOURCES = ("oanda", "binance", "yahoo", "dukascopy")
YAHOO_INTERVALS = {
    "M1": "1m",
    "M5": "5m",
    "M15": "15m",
    "H1": "1h",
    "D1": "1d",
    "W1": "1wk",
    "MN": "1mo",
}


def enabled_sources():
    return tuple(s for s in SOURCES if s != "yahoo" or settings.yahoo_enabled)


def frames(source):
    if source not in SOURCES:
        raise ValueError("未知平台源")
    return tuple(YAHOO_INTERVALS) if source == "yahoo" else FRAMES


def page_capacity(source):
    return 4000 if source in ("oanda", "yahoo", "dukascopy") else 1000


def fresh_seconds(source):
    return settings.yahoo_poll_seconds if source == "yahoo" else settings.provider_fresh_seconds


def poll_seconds(source):
    return settings.yahoo_poll_seconds if source == "yahoo" else settings.market_poll_seconds


def versions(meta):
    if meta["source"] == "dukascopy":
        return ("dukascopy-json3-bid-utc-splits-stocks-v1", "dukascopy-native-quantity-v1")
    if meta["source"] == "yahoo":
        rules = hashlib.sha256(json.dumps([meta.get("timezone"), meta.get("session")]).encode()).hexdigest()[:16]
        return ("yahoo-exchange-label-v1:" + meta["adjustment"] + ":" + rules, "yahoo-volume-v1")
    return ("native-bid-ny17-sunday-v1", "volume-v1")


def history_policy(frame):
    # These are configurable request policy estimates, not permanent exhaustion.
    if frame == "M1":
        return settings.yahoo_m1_retention_days, settings.yahoo_m1_span_days
    if frame in ("M5", "M15"):
        return settings.yahoo_minute_retention_days, settings.yahoo_minute_retention_days
    if frame == "H1":
        return settings.yahoo_hour_retention_days, settings.yahoo_hour_retention_days
    return None, None
