"""One leased multi-instrument stream plus an independent REST confirmation loop."""

import logging
import re
import signal
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from .config import settings
from .live_pricing import (
    begin_connection,
    claim,
    claim_auth_probe,
    commit_confirmation,
    confirmation_window,
    desired_datasets,
    disconnected,
    ensure_catalog,
    finish_auth_probe,
    park_closed,
    publish_event,
    recovery_requirements,
    renew,
    session_states,
    startup_failed,
    wait_delay,
)
from .market_contracts import RequestResult, failed_request
from .market_resources import cooldown, lane
from .oanda_stream import OandaPractice
from .storage import now_ms

log = logging.getLogger(__name__)


def log_failure(event, error, *, stage, epoch=None):
    """Keep classification useful without exception text or SQL parameters."""
    result = failed_request(error, observed_at=now_ms())
    sqlstate = getattr(getattr(error, "orig", None), "sqlstate", None)
    if not isinstance(sqlstate, str) or not re.fullmatch(r"[0-9A-Z]{5}", sqlstate):
        sqlstate = "-"
    log.warning("%s status=%s stage=%s type=%s sqlstate=%s epoch=%s",
                event, result.status, stage, type(error).__name__, sqlstate, epoch)
    return result


def subscription_change(identities, desired, idle_since, now):
    if desired:
        return None, set(desired) != set(identities)
    idle_since = now if idle_since is None else idle_since
    return idle_since, now - idle_since >= settings.oanda_idle_grace_seconds


def closed_delay(identities, *, now=None):
    stamp = now_ms() if now is None else now
    states = session_states(identities, now=stamp)
    if not states or any(row['market_session'] != 'closed' for row in states.values()):
        return None
    boundary = min(row['next_session_at'] for row in states.values())
    return min(settings.oanda_closed_probe_seconds, max(1, (boundary - stamp) / 1000))


def probe_authentication(adapter, ownership):
    identities = desired_datasets(adapter.account_id)
    delay = closed_delay(identities)
    symbols = set(identities) | {
        s.strip() for s in settings.oanda_resident_symbols.split(',') if s.strip()}
    catalog = None
    try:
        with lane('realtime'):
            catalog = adapter.validate_access(symbols)
        ensure_catalog(catalog, adapter.account_id, ownership=ownership)
        result = RequestResult(status='data')
    except Exception as error:
        catalog = None
        result = log_failure('pricing_auth_probe_failed', error, stage='auth_probe')
        if result.status == 'rate_limited':
            cooldown('oanda', retry_seconds=max(1, (result.retry_at-now_ms())/1000) if result.retry_at else None)
    finish_auth_probe(ownership, result, retry_seconds=delay)
    return catalog


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
                if window and session_states({identity.provider_symbol: identity})[identity.provider_symbol]['market_session'] != 'closed':
                    pending.append(pool.submit(fetch, identity, window))
            for future in pending:
                batch = future.result()
                if cancelled():
                    return None
                commit_confirmation(ownership, epoch, batch)
                if batch.result.status in ('unauthorized', 'provider_maintenance'):
                    return batch.result
    return None


def collect(adapter, ownership, identities, stopped):
    requirements = recovery_requirements(identities)
    epoch = begin_connection(ownership, identities)
    connection_stop = threading.Event()
    lost = threading.Event()
    maintenance_error = []
    intentional_stop = threading.Event()
    closed_stop = threading.Event()

    def guard():
        while not stopped.is_set() and not connection_stop.is_set():
            try:
                if not renew(ownership):
                    log.warning("pricing_ownership_lost reason=lease_not_renewed stage=guard epoch=%s", epoch)
                    lost.set()
                    return
            except Exception as error:
                # Any inability to prove ownership fences publishing immediately.
                log_failure("pricing_ownership_lost", error, stage="guard", epoch=epoch)
                lost.set()
                return
            connection_stop.wait(5)

    def maintenance():
        refreshed = 0
        idle_since = None
        while not stopped.is_set() and not connection_stop.is_set():
            stage = "renew"
            try:
                if not renew(ownership):
                    log.warning("pricing_ownership_lost reason=lease_not_renewed stage=maintenance epoch=%s", epoch)
                    lost.set()
                    return
                if time.monotonic() - refreshed >= 10:
                    stage = "subscription"
                    desired = desired_datasets(adapter.account_id)
                    current = time.monotonic()
                    idle_since, changed = subscription_change(identities, desired, idle_since, current)
                    if changed:
                        log.info("pricing_connection_stopping reason=subscription_change epoch=%s", epoch)
                        intentional_stop.set()
                        connection_stop.set()
                        return
                    if closed_delay(identities) is not None:
                        closed_stop.set()
                        connection_stop.set()
                        return
                    if any(minutes > requirements[key] for key, minutes in recovery_requirements(identities).items()):
                        log.info("pricing_connection_stopping reason=recovery_requirement epoch=%s", epoch)
                        intentional_stop.set()
                        connection_stop.set()
                        return
                    refreshed = time.monotonic()
                stage = "confirmation"
                error = confirm_pages(adapter, ownership, epoch, identities,
                    lambda: stopped.is_set() or connection_stop.is_set() or lost.is_set())
                if error:
                    maintenance_error.append(error)
                    connection_stop.set()
                    return
            except TimeoutError as error:
                log_failure("pricing_ownership_lost", error, stage=stage, epoch=epoch)
                lost.set()
                return
            except Exception as error:
                log_failure("pricing_maintenance_failed", error, stage=stage, epoch=epoch)
            connection_stop.wait(1)

    # SDK REST requests have bounded timeouts. Network waits never hold a DB
    # transaction or the streaming client's single connection.
    thread = threading.Thread(target=maintenance, name="oanda-confirmation", daemon=True)
    guardian = threading.Thread(target=guard, name="oanda-lease", daemon=True)
    guardian.start()
    thread.start()
    result = RequestResult(status="unavailable")
    stage = "stream"
    try:
        for event in adapter.stream(identities, epoch=epoch,
                stopped=lambda: stopped.is_set() or connection_stop.is_set() or lost.is_set()):
            if stopped.is_set() or connection_stop.is_set() or lost.is_set():
                break
            stage = "publish"
            publish_event(ownership, epoch, event, identities)
            stage = "stream"
    except Exception as error:
        result = log_failure("pricing_stream_ended", error, stage=stage, epoch=epoch)
        if result.status == "rate_limited":
            seconds = max(1, (result.retry_at - now_ms()) / 1000) if result.retry_at else None
            cooldown("oanda", retry_seconds=seconds)
    else:
        if not (stopped.is_set() or connection_stop.is_set() or lost.is_set()):
            log.info("pricing_stream_closed reason=eof epoch=%s", epoch)
    finally:
        connection_stop.set()
        thread.join(timeout=20)
        guardian.join(timeout=6)
        if not lost.is_set():
            try:
                delay = closed_delay(identities) if closed_stop.is_set() else None
                if delay is not None:
                    park_closed(ownership, identities, delay)
                else:
                    disconnected(ownership, epoch, identities, maintenance_error[-1] if maintenance_error else result,
                                 intentional=intentional_stop.is_set())
            except TimeoutError:
                pass


def run(adapter, stopped):
    catalog = None
    while not stopped.is_set():
        ownership = claim(adapter.account_id, startup=True)
        if ownership is None:
            probe = claim_auth_probe(adapter.account_id)
            if probe is not None:
                try:
                    catalog = probe_authentication(adapter, probe)
                except TimeoutError:
                    # A dead/superseded probe cannot alter the new owner's hold.
                    pass
            stopped.wait(wait_delay(adapter.account_id))
            continue
        try:
            # The shared account lease also serializes startup catalog calls.
            if catalog is None:
                with lane('realtime'):
                    catalog = adapter.catalog()
                ensure_catalog(catalog, adapter.account_id, ownership=ownership)
            identities = desired_datasets(adapter.account_id)
            delay = closed_delay(identities)
            if delay is not None or not identities:
                park_closed(ownership, identities, delay if delay is not None else 1)
                continue
            collect(adapter, ownership, identities, stopped)
        except Exception as error:
            result = log_failure('pricing_start_failed', error, stage='startup')
            try:
                startup_failed(ownership, adapter.account_id, result)
            except TimeoutError:
                pass
            catalog = None


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
                result = log_failure("pricing_start_failed", error, stage="startup")
                stopped.wait(settings.oanda_auth_probe_seconds if result.status == 'unauthorized' else 15)
    finally:
        adapter.close()


if __name__ == "__main__":
    main()
