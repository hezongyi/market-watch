"""Dedicated latest-M1 acquisition; history downloads cannot occupy its HTTP client.

Uses the existing ingestion, recovery and alert evaluation path. Replaces the
ordinary market-worker in deployments opting into chart demand maintenance.
"""
import logging
import signal
import threading
import time
from contextlib import ExitStack

import httpx

from .config import settings
from .market import fetch_source, import_once, once, realtime_error
from .market_resources import lane
from .providers import fetch_binance, fetch_oanda
from .runtime_health import progress


def run(stop):
    with ExitStack() as stack:
        clients = {
            "oanda": stack.enter_context(httpx.Client(timeout=15,
                proxy=settings.oanda_proxy or None, trust_env=False)),
        }

        def fetch(source, symbol, start=None, end=None, mode="live"):
            provider = {"oanda": fetch_oanda, "binance": fetch_binance}.get(source)
            if provider is None:
                return fetch_source(source, symbol, start, end, mode=mode)
            return provider(symbol, start, end, mode=mode, client=clients.get(source))

        # In REST-batch mode OANDA's account-scoped pricing worker owns every
        # OANDA live M1 request.  Keep this legacy worker available for
        # Binance/Dukascopy, but exclude OANDA from both its viewer cycle and
        # its realtime import queue so it cannot issue duplicate pricing or
        # single-instrument candle requests.
        source_filter = None if settings.oanda_acquisition_mode == "stream" else (
            "binance", "dukascopy")

        while not stop.is_set():
            started = time.monotonic()
            try:
                with lane("realtime"):
                    once(include_viewers=False, fetcher=fetch, source_filter=source_filter)
                    import_once(realtime_only=True, fetcher=fetch, source_filter=source_filter)
                logging.info("realtime_cycle seconds=%.3f", time.monotonic()-started)
                error = realtime_error(source_filter)
                progress(state="degraded" if error else "idle", error=error)
            except Exception as error:
                # Provider/DB details can contain account identifiers.
                logging.warning("realtime_cycle_failed type=%s", type(error).__name__)
                progress(state="degraded", error=error)
            stop.wait(max(1, settings.market_poll_seconds-(time.monotonic()-started)))


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    stopped = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stopped.set())
    run(stopped)


if __name__ == "__main__":
    main()
