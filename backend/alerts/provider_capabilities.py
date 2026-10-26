"""The native provider differences shared by readers, workers and transport."""

import hashlib
import json

from .chart_data import FRAMES
from .config import settings

SOURCES = ("oanda", "binance", "yahoo", "dukascopy", "akshare", "fxcm")
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
    # OANDA's account-scoped live path is owned by ``oanda_worker`` in REST
    # batch mode.  Do not start the legacy provider-service poller alongside
    # it; otherwise native/provider interests can issue pricing or single
    # instrument candle requests outside the shared lease.
    return tuple(s for s in SOURCES
                 if (s != "oanda" or settings.oanda_acquisition_mode == "stream")
                 and (s != "yahoo" or settings.yahoo_enabled)
                 and (s != "akshare" or settings.akshare_enabled)
                 and (s != "fxcm" or settings.fxcm_enabled))


def frames(source):
    if source not in SOURCES:
        raise ValueError("未知平台源")
    return tuple(YAHOO_INTERVALS) if source == "yahoo" else FRAMES


def page_capacity(source):
    if source == "fxcm":
        return 300
    return 4000 if source in ("oanda", "yahoo", "dukascopy") else 1000


def request_seconds(source):
    # A cold ForexConnect session needs login plus one finite snapshot.
    if source == "fxcm":
        return 65
    # AKShare starts a disposable SDK process and Sina serves a full daily
    # snapshot. Keep the chart wait bounded by that adapter's 30-second budget.
    return max(30, settings.provider_request_seconds) if source == "akshare" else settings.provider_request_seconds


def fresh_seconds(source):
    if source == "fxcm":
        # FXCM finite snapshots are polled at most once a minute. Reuse that
        # observation through its polling interval, including cold-login time.
        return poll_seconds(source)
    return settings.yahoo_poll_seconds if source == "yahoo" else settings.provider_fresh_seconds


def poll_seconds(source):
    return max(60, settings.market_poll_seconds) if source == "fxcm" else settings.yahoo_poll_seconds if source == "yahoo" else settings.market_poll_seconds


def versions(meta):
    if meta["source"] == "oanda":
        from .native_series import parameters
        native = parameters(meta)
        rules = hashlib.sha256(json.dumps(native, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        # Both history and latest now use this configured account with units=1.
        # Preserve legacy caches; their instrument-only prices are not reusable.
        return ("oanda-account-candles-units1-v2:" + rules, "volume-v1")
    if meta["source"] == "fxcm":
        return ("fxcm-demo-bid-native-v1:" + meta["account_scope"], "fxcm-tick-count-v1")
    if meta["source"] == "dukascopy":
        return ("dukascopy-json3-bid-utc-splits-stocks-v1", "dukascopy-native-quantity-v1")
    if meta["source"] == "yahoo":
        rules = hashlib.sha256(json.dumps([meta.get("timezone"), meta.get("session")]).encode()).hexdigest()[:16]
        return ("yahoo-exchange-label-v1:" + meta["adjustment"] + ":" + rules, "yahoo-volume-v1")
    if meta["source"] == "akshare":
        from .provider_akshare import RULES

        return (RULES + ":" + meta["source_family"] + ":" + meta["adjustment"], "akshare-quantity-v1")
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
