"""Dedicated low-concurrency chart import worker; no notification sending."""

import logging
import threading
from contextlib import ExitStack

import httpx

from .chart_history_plan import advance_pending_plans
from .config import settings
from .market import fetch_source, import_once
from .market_resources import lane
from .providers import fetch_binance, fetch_oanda


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    # Provider URLs contain account paths; keep transport request logs quiet.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.info(
        "chart_history_start module=%s oanda_proxy=%s binance_proxy=%s",
        __file__, bool(settings.oanda_proxy), bool(settings.effective_binance_proxy),
    )
    with ExitStack() as stack:
        clients = {
            "oanda": stack.enter_context(httpx.Client(timeout=15, proxy=settings.oanda_proxy or None, trust_env=False)),
        }
        def fetch_page(source, symbol, start, end):
            provider = {"oanda": fetch_oanda, "binance": fetch_binance}.get(source)
            if provider is None:
                return fetch_source(source, symbol, start, end)
            return provider(symbol, start, end, client=clients.get(source))
        run(fetch_page, threading.Event())


def run(fetch_page, stop=None):
    from .publication_wakeup import HISTORY_CHANNEL, PublicationWakeup

    with PublicationWakeup(channel=HISTORY_CHANNEL) as wake:
        _run(fetch_page, stop, wake)


def pending_work():
    """Future retries keep the existing one-second discovery cadence."""
    from sqlalchemy import select

    from .storage import ChartHistoryPlan, ImportJob, VolumeBackfillJob, transaction

    with transaction() as db:
        return any(db.scalar(select(model).where(model.status.in_(states)).limit(1))
                   for model, states in ((ImportJob, ("pending", "running")),
                       (ChartHistoryPlan, ("pending",)),
                       (VolumeBackfillJob, ("pending", "running"))))


def _run(fetch_page, stop, wake):
    from .worker_health import Pulse

    pulse = Pulse("chart_history")
    stop = stop if stop is not None else threading.Event()
    # Directory scheduling belongs to catalog_runtime, not history imports.
    while not stop.is_set():
        wake.prepare()
        try:
            pulse.start()
            # Reevaluate after every completed page; do not idle for the
            # maintenance timer while a foreground window is still incomplete.
            advance_pending_plans()
            # Recent repair is owned by the realtime worker. Manual and old
            # recovery work share this bounded historical executor.
            with lane('history'):
                worked = import_once(fetcher=fetch_page, defer_aggregation=True, history_only=True)
                if not worked:
                    worked = import_once(chart_only=True, fetcher=fetch_page, defer_aggregation=True, history_only=True)
                if not worked:
                    from .volume_jobs import once
                    worked = once(fetch_page)
            pulse.finish(worked=worked)
            from .runtime_health import progress
            progress()
            if worked:
                stop.wait(0.2)
            else:
                wake.wait(1 if pending_work() else 5, stop)
        except Exception as exc:
            pulse.finish(errors=[type(exc).__name__])
            from .runtime_health import progress
            progress(error=exc)
            logging.warning("chart history cycle failed: %s", type(exc).__name__)
            stop.wait(5)


if __name__ == "__main__":
    main()
