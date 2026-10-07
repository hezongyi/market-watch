"""One leased multi-instrument stream plus an independent REST confirmation loop."""

import logging
import signal
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from .config import settings
from .live_pricing import (
    begin_connection,
    claim,
    commit_confirmation,
    confirmation_window,
    desired_datasets,
    disconnected,
    ensure_catalog,
    publish_event,
    recovery_requirements,
    renew,
)
from .market_contracts import RequestResult, failed_request
from .market_resources import cooldown, lane
from .oanda_stream import OandaPractice
from .storage import now_ms

log = logging.getLogger(__name__)


def subscription_change(identities, desired, idle_since, now):
    if desired:
        return None, set(desired) != set(identities)
    idle_since = now if idle_since is None else idle_since
    return idle_since, now - idle_since >= settings.oanda_idle_grace_seconds


def confirm_pages(adapter, ownership, epoch, identities, cancelled):
    """Overlap at most two REST waits; fenced commits remain on the caller.

    The shared realtime lane still limits both concurrent slots and request rate.
    Only one bounded pair is submitted at a time, so subscription changes and
    auth faults cannot leave a queue of obsolete source requests.
    """
    def fetch(identity, window):
        with lane("realtime"):
            return adapter.page(identity, *window)

    values = list(identities.values())
    with ThreadPoolExecutor(max_workers=2, thread_name_prefix="oanda-confirm-rest") as pool:
        for offset in range(0, len(values), 2):
            if cancelled():
                return None
            pending = []
            for identity in values[offset:offset + 2]:
                window = confirmation_window(ownership, epoch, identity)
                if window:
                    pending.append(pool.submit(fetch, identity, window))
            for future in pending:
                batch = future.result()
                if cancelled():
                    return None
                commit_confirmation(ownership, epoch, batch)
                if batch.result.status == "unauthorized":
                    return batch.result
    return None


def collect(adapter, ownership, identities, stopped):
    requirements = recovery_requirements(identities)
    epoch = begin_connection(ownership, identities)
    connection_stop = threading.Event()
    lost = threading.Event()
    maintenance_error = []
    intentional_stop = threading.Event()

    def guard():
        while not stopped.is_set() and not connection_stop.is_set():
            try:
                if not renew(ownership):
                    lost.set()
                    return
            except Exception:
                # Any inability to prove ownership fences publishing immediately.
                lost.set()
                return
            connection_stop.wait(5)

    def maintenance():
        refreshed = 0
        idle_since = None
        while not stopped.is_set() and not connection_stop.is_set():
            try:
                if not renew(ownership):
                    lost.set()
                    return
                if time.monotonic() - refreshed >= 10:
                    desired = desired_datasets(adapter.account_id)
                    current = time.monotonic()
                    idle_since, changed = subscription_change(identities, desired, idle_since, current)
                    if changed:
                        intentional_stop.set()
                        connection_stop.set()
                        return
                    if any(minutes > requirements[key] for key, minutes in recovery_requirements(identities).items()):
                        intentional_stop.set()
                        connection_stop.set()
                        return
                    refreshed = time.monotonic()
                error = confirm_pages(adapter, ownership, epoch, identities,
                    lambda: stopped.is_set() or connection_stop.is_set() or lost.is_set())
                if error:
                    maintenance_error.append(error)
                    connection_stop.set()
                    return
            except TimeoutError:
                lost.set()
                return
            except Exception as error:
                log.warning("pricing_maintenance_failed type=%s", type(error).__name__)
            connection_stop.wait(1)

    # SDK REST requests have bounded timeouts. Network waits never hold a DB
    # transaction or the streaming client's single connection.
    thread = threading.Thread(target=maintenance, name="oanda-confirmation", daemon=True)
    guardian = threading.Thread(target=guard, name="oanda-lease", daemon=True)
    guardian.start()
    thread.start()
    result = RequestResult(status="unavailable")
    try:
        for event in adapter.stream(identities, epoch=epoch,
                stopped=lambda: stopped.is_set() or connection_stop.is_set() or lost.is_set()):
            if stopped.is_set() or connection_stop.is_set() or lost.is_set():
                break
            publish_event(ownership, epoch, event, identities)
    except Exception as error:
        result = failed_request(error, observed_at=now_ms())
        log.warning("pricing_stream_ended status=%s", result.status)
        if result.status == "rate_limited":
            seconds = max(1, (result.retry_at - now_ms()) / 1000) if result.retry_at else None
            cooldown("oanda", retry_seconds=seconds)
    finally:
        connection_stop.set()
        thread.join(timeout=20)
        guardian.join(timeout=6)
        if not lost.is_set():
            try:
                disconnected(ownership, epoch, identities, maintenance_error[-1] if maintenance_error else result,
                             intentional=intentional_stop.is_set())
            except TimeoutError:
                pass


def run(adapter, stopped):
    # Catalog is account-scoped, and is read before any source IDs are created.
    with lane("realtime"):
        ensure_catalog(adapter.catalog(), adapter.account_id)
    while not stopped.is_set():
        identities = desired_datasets(adapter.account_id)
        if not identities:
            stopped.wait(1)
            continue
        ownership = claim(adapter.account_id)
        if ownership is None:
            stopped.wait(1)
            continue
        collect(adapter, ownership, identities, stopped)


def main():
    if not settings.oanda_stream_enabled:
        raise SystemExit("Set ALERTS_OANDA_STREAM_ENABLED=true for this isolated worker")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    stopped = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stopped.set())
    adapter = OandaPractice(token=settings.oanda_token, account_id=settings.oanda_account_id,
                           proxy=settings.oanda_proxy or settings.market_proxy)
    try:
        while not stopped.is_set():
            try:
                run(adapter, stopped)
            except Exception as error:
                # Auth/config faults remain quiet and bounded, without account URLs.
                result = failed_request(error, observed_at=now_ms())
                log.warning("pricing_start_failed status=%s", result.status)
                stopped.wait(60 if result.status == "unauthorized" else 15)
    finally:
        adapter.close()


if __name__ == "__main__":
    main()
