"""Dedicated latest-M1 acquisition; history downloads cannot occupy its HTTP client.

Uses the existing ingestion, recovery and alert evaluation path. Replaces the
ordinary market-worker in deployments opting into chart demand maintenance.
"""
import logging
import time
from contextlib import ExitStack

import httpx

from .config import settings
from .market import fetch_source, import_once, once
from .market_resources import lane
from .providers import fetch_binance, fetch_oanda


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    with ExitStack() as stack:
        clients = {
            "oanda": stack.enter_context(httpx.Client(timeout=15,
                proxy=settings.oanda_proxy or None, trust_env=False)),
            "binance": stack.enter_context(httpx.Client(timeout=15,
                proxy=settings.effective_binance_proxy or None, trust_env=False)),
        }

        def fetch(source, symbol, start=None, end=None, mode="live"):
            provider = {"oanda": fetch_oanda, "binance": fetch_binance}.get(source)
            if provider is None:
                return fetch_source(source, symbol, start, end, mode=mode)
            return provider(symbol, start, end, mode=mode, client=clients[source])

        while True:
            started = time.monotonic()
            try:
                with lane("realtime"):
                    once(include_viewers=True, fetcher=fetch)
                    import_once(realtime_only=True, fetcher=fetch)
                logging.info("realtime_cycle seconds=%.3f", time.monotonic()-started)
            except Exception as error:
                # Provider/DB details can contain account identifiers.
                logging.warning("realtime_cycle_failed type=%s", type(error).__name__)
            time.sleep(max(1, settings.market_poll_seconds-(time.monotonic()-started)))


if __name__ == "__main__":
    main()
