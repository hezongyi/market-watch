"""Dedicated low-concurrency chart import worker; no notification sending."""

import logging
import time
from contextlib import ExitStack

import httpx

from .chart_history_plan import advance_pending_plans
from .config import settings
from .market import import_once
from .market_data import advance_weekly_request, refresh_catalog
from .providers import fetch_binance, fetch_oanda


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    # Provider URLs contain account paths; keep transport request logs quiet.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.info(
        "chart_history_start module=%s oanda_proxy=%s binance_proxy=%s",
        __file__, bool(settings.oanda_proxy), bool(settings.binance_proxy),
    )
    with ExitStack() as stack:
        clients = {
            "oanda": stack.enter_context(httpx.Client(timeout=15, proxy=settings.oanda_proxy or None, trust_env=False)),
            "binance": stack.enter_context(httpx.Client(timeout=15, proxy=settings.binance_proxy or None)),
        }
        def fetch_page(source, symbol, start, end):
            provider = {"oanda": fetch_oanda, "binance": fetch_binance}[source]
            return provider(symbol, start, end, client=clients[source])
        run(fetch_page)


def run(fetch_page):
    refreshed = 0
    maintained = 0
    while True:
        try:
            if time.monotonic() - refreshed > 86400:
                try:
                    refresh_catalog()
                    refreshed = time.monotonic()
                except Exception as exc:
                    logging.warning("catalog refresh failed: %s",type(exc).__name__)
                    refreshed = time.monotonic()-86400+300
            if time.monotonic() - maintained > 15:
                advance_weekly_request()
                maintained = time.monotonic()
            # Reevaluate after every completed page; do not idle for the
            # maintenance timer while a foreground window is still incomplete.
            advance_pending_plans()
            worked = import_once(chart_only=True, fetcher=fetch_page)
            time.sleep(0.2 if worked else 1)
        except Exception as exc:
            logging.warning("chart history cycle failed: %s", type(exc).__name__)
            time.sleep(5)


if __name__ == "__main__":
    main()
