"""Dedicated low-concurrency chart import worker; no notification sending."""

import logging
import time

from sqlalchemy import select

from .market import import_once
from .market_data import queue_history, refresh_catalog
from .storage import Instrument, MarketDemand, now_ms, transaction


def maintain_active():
    end = (now_ms() - 5000) // 60000 * 60000
    with transaction() as db:
        ids = set(
            db.scalars(select(MarketDemand.instrument_id).where(MarketDemand.expires > now_ms()))
        )
        for ident in ids:
            inst = db.get(Instrument, ident)
            queue_history(db, inst, end - 120 * 60000, end)


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    # Provider URLs contain account paths; keep transport request logs quiet.
    logging.getLogger("httpx").setLevel(logging.WARNING)
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
                maintain_active()
                maintained = time.monotonic()
            worked = import_once(chart_only=True)
            time.sleep(0.2 if worked else 1)
        except Exception as exc:
            logging.warning("chart history cycle failed: %s", type(exc).__name__)
            time.sleep(5)


if __name__ == "__main__":
    main()
