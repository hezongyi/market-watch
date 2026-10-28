"""One leased multi-instrument stream plus an independent REST confirmation loop."""

import hashlib
import logging
import re
import signal
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context

from .config import settings
from .live_confirmation import runtime_error as confirmation_error
from .live_pricing import (
    begin_connection,
    claim,
    claim_auth_probe,
    commit_confirmation,
    confirmation_window,
    desired_dataset_identities,
    desired_datasets,
    desired_native_provider_datasets,
    disconnected,
    ensure_catalog,
    finish_auth_probe,
    lock_owner,
    park_closed,
    publish_event,
    publish_rest_batch,
    recovery_requirements,
    renew,
    session_states,
    startup_failed,
    wait_delay,
)
from .market_contracts import RequestResult, failed_request
from .market_resources import cooldown, lane
from .oanda_rest_batch import (
    MAX_SPECIFICATIONS,
    CandleSpec,
    OandaRestBatch,
    live_demand_revision,
)
from .oanda_stream import OandaPractice
from .runtime_health import progress
from .runtime_supervisor import UnstoppedThreads, require_stopped
from .storage import now_ms, transaction

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


def desired_for_mode(account):
    """Use complete identity keys for REST, symbol keys for stream legacy."""
    if settings.oanda_acquisition_mode == "rest_batch":
        return {identity.key: identity for identity in desired_dataset_identities(account)}
    return desired_datasets(account)


def native_specs(account):
    """Resolve active provider interests to complete REST candle specs."""
    if settings.oanda_native_latest_owner != "pricing":
        return ()
    return tuple(
        (row.id, row.timeframe, CandleSpec.from_provider_metadata(row.metadata_json, row.timeframe))
        for row in desired_native_provider_datasets(account)
    )


def demand_fingerprint(identities, native):
    return (
        tuple(sorted(getattr(identity, "key", key) for key, identity in identities.items())),
        tuple(sorted(spec.key for *_, spec in native)),
    )


def request_groups(live_specs, native):
    """Yield same-parameter REST batches within the supplier envelope."""
    groups = {}
    for key, spec in live_specs:
        group_key = getattr(spec, "group_key", spec.key)
        groups.setdefault(group_key, {"live": [], "native": []})["live"].append((key, spec))
    for dataset_id, timeframe, spec in native:
        groups.setdefault(spec.group_key, {"live": [], "native": []})["native"].append(
            (dataset_id, timeframe, spec))
    for original in groups.values():
        entries = [("live", row) for row in original["live"]] + [
            ("native", row) for row in original["native"]]
        for offset in range(0, len(entries), MAX_SPECIFICATIONS):
            chunk = entries[offset:offset + MAX_SPECIFICATIONS]
            yield {
                "live": [row for kind, row in chunk if kind == "live"],
                "native": [row for kind, row in chunk if kind == "native"],
            }


def closed_delay(identities, *, now=None):
    stamp = now_ms() if now is None else now
    states = session_states(identities, now=stamp)
    if not states or any(row['market_session'] != 'closed' for row in states.values()):
        return None
    boundary = min(row['next_session_at'] for row in states.values())
    return min(settings.oanda_closed_probe_seconds, max(1, (boundary - stamp) / 1000))


def probe_authentication(adapter, ownership):
    identities = desired_for_mode(adapter.account_id)
    native = native_specs(adapter.account_id) if settings.oanda_acquisition_mode == "rest_batch" else ()
    delay = closed_delay(identities)
    symbols = {identity.provider_symbol for identity in identities.values()} | {
        s.strip() for s in settings.oanda_resident_symbols.split(',') if s.strip()} | {
        spec.provider_symbol for _, _, spec in native}
    catalog = None
    try:
        with lane('realtime'):
            if isinstance(adapter, OandaRestBatch):
                scope = 'sha256:' + hashlib.sha256(adapter.account_id.encode()).hexdigest()
                specs = [CandleSpec(
                    account_scope=scope, provider_symbol=symbol) for symbol in sorted(symbols)]
                catalog = adapter.validate_candle_access(specs)
            else:
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


def collect_rest(adapter, ownership, identities, stopped, native=()):
    """Run one fenced fixed-cadence REST batch connection.

    ``candles/latest`` is deliberately kept on the foreground cadence while
    complete-minute recovery runs in a bounded maintenance thread.  A latest
    response is not a coverage assertion: after a restart or a long outage we
    must use the checkpointed ``page`` path before declaring the source ready.
    """
    epoch = begin_connection(ownership, identities)
    native = tuple(native)
    connection_stop = threading.Event()
    intentional_stop = threading.Event()
    closed_stop = threading.Event()
    health_lock = threading.Lock()
    confirmation_fault = [None]

    def report_confirmation(error):
        with health_lock:
            if error is None and lost.is_set():
                return
            confirmation_fault[0] = error
            if error:
                progress(state="degraded", error=error)
    lost = threading.Event()
    maintenance_error = []
    sequence = 0
    tick = time.monotonic()
    terminal_result = RequestResult(status="unavailable")

    def maintenance():
        """Renew the lease and drain bounded complete-M1 recovery windows."""
        refreshed = 0.0
        while not stopped.is_set() and not connection_stop.is_set():
            stage = "renew"
            try:
                if not renew(ownership):
                    lost.set()
                    report_confirmation("ownership_lost")
                    return
                if time.monotonic() - refreshed >= 10:
                    stage = "subscription"
                    desired = desired_for_mode(adapter.account_id)
                    desired_native = (native_specs(adapter.account_id)
                                      if native or settings.oanda_acquisition_mode == "rest_batch" else ())
                    if demand_fingerprint(desired, desired_native) != demand_fingerprint(identities, native):
                        intentional_stop.set()
                        connection_stop.set()
                        return
                    delay = closed_delay(identities)
                    if delay is not None:
                        closed_stop.set()
                        connection_stop.set()
                        return
                    refreshed = time.monotonic()
                stage = "confirmation"
                failure = confirm_pages(
                    adapter, ownership, epoch, identities,
                    lambda: stopped.is_set() or connection_stop.is_set() or lost.is_set(),
                )
                if failure:
                    report_confirmation(failure.status)
                    maintenance_error.append(failure)
                    connection_stop.set()
                    return
                report_confirmation(confirmation_error(identities, epoch))
            except TimeoutError as error:
                lost.set()
                report_confirmation(type(error).__name__)
                return
            except Exception as error:
                # Keep the fixed-cadence latest loop alive for transient page
                # failures; the page path records its own retry state.
                log_failure("pricing_maintenance_failed", error, stage=stage, epoch=epoch)
                report_confirmation(type(error).__name__)
            connection_stop.wait(1)

    # Test doubles and non-OANDA adapters may expose only ``latest``.  The
    # production REST adapter inherits ``page`` and always gets recovery.
    maintenance_thread = None
    if hasattr(adapter, "page"):
        maintenance_thread = threading.Thread(
            target=copy_context().run, args=(maintenance,),
            name="oanda-rest-confirmation", daemon=True
        )
        maintenance_thread.start()
    try:
        while not stopped.is_set() and not connection_stop.is_set():
            if not renew(ownership):
                raise TimeoutError('REST ownership expired')
            if tick > time.monotonic():
                connection_stop.wait(tick - time.monotonic())
            if stopped.is_set() or connection_stop.is_set() or lost.is_set():
                break
            desired = desired_for_mode(adapter.account_id)
            desired_native = (native_specs(adapter.account_id)
                              if native or settings.oanda_acquisition_mode == "rest_batch" else ())
            if demand_fingerprint(desired, desired_native) != demand_fingerprint(identities, native):
                intentional_stop.set()
                break
            delay = closed_delay(identities)
            if delay is not None:
                closed_stop.set()
                break
            live_specs = [(getattr(identity, "key", key), CandleSpec.from_dataset(identity))
                          for key, identity in identities.items()]
            for group in request_groups(live_specs, native):
                if stopped.is_set() or connection_stop.is_set() or lost.is_set():
                    break
                sequence += 1
                specs = [spec for _, spec in group["live"]] + [spec for _, _, spec in group["native"]]
                full_revision = live_demand_revision(specs)
                with lane('realtime'):
                    batch = adapter.latest(specs, generation=epoch, sequence=sequence,
                        demand_revision=full_revision,
                        deadline=time.monotonic() + max(7, settings.oanda_rest_interval_seconds * 2),
                        cancelled=lambda: stopped.is_set() or connection_stop.is_set())
                # A cancelled or superseded request may still return a successful
                # HTTP response.  Once the connection is fenced, that response is
                # no longer allowed to publish a snapshot or alert.
                if stopped.is_set() or connection_stop.is_set() or lost.is_set():
                    break
                # Demand can change while the HTTP request is in flight. Fence the
                # response before any confirmation or provisional/cache commit.
                desired_after_request = desired_for_mode(adapter.account_id)
                desired_native_after = (native_specs(adapter.account_id)
                                        if native or settings.oanda_acquisition_mode == "rest_batch" else ())
                if demand_fingerprint(desired_after_request, desired_native_after) != demand_fingerprint(identities, native):
                    intentional_stop.set()
                    connection_stop.set()
                    break
                if group["live"]:
                    live = {key: identities[key] for key, _ in group["live"]}
                    publish_rest_batch(ownership, epoch, batch, live, demand_revision=full_revision)
                if group["native"]:
                    publish_native_rest_batch(ownership, epoch, batch, group["native"], demand_revision=full_revision)
                with health_lock:
                    error = ("ownership_lost" if lost.is_set() else confirmation_fault[0]) or (
                        None if batch.result.status == "data" else batch.result.status)
                    progress(state="degraded" if error else "running", error=error)
                if batch.result.status in ('unauthorized', 'provider_maintenance'):
                    terminal_result = batch.result
                    connection_stop.set()
                    break
            if connection_stop.is_set():
                break
            tick += settings.oanda_rest_interval_seconds
            now = time.monotonic()
            if tick <= now:
                skipped = int((now - tick) // settings.oanda_rest_interval_seconds) + 1
                tick += skipped * settings.oanda_rest_interval_seconds
    finally:
        connection_stop.set()
        if maintenance_thread is not None:
            maintenance_thread.join(timeout=20)
            require_stopped((maintenance_thread,))
        if maintenance_error:
            terminal_result = maintenance_error[-1]
        if lost.is_set():
            return
        if closed_stop.is_set():
            try:
                park_closed(ownership, identities, closed_delay(identities) or 1)
            except TimeoutError:
                pass
        else:
            try:
                disconnected(ownership, epoch, identities, terminal_result,
                             intentional=intentional_stop.is_set() or stopped.is_set())
            except TimeoutError:
                pass


def publish_native_rest_batch(ownership, epoch, batch, datasets, *, demand_revision=None):
    """Publish native provider-period rows through the shared cache lease."""
    from .oanda_rest_batch import LatestBatch
    from .provider_cache import commit_rest_latest

    batch = LatestBatch.model_validate(batch)
    if batch.generation != epoch:
        raise TimeoutError("REST native batch generation is obsolete")
    if demand_revision is not None and batch.demand_revision != demand_revision:
        raise TimeoutError("REST native batch demand is obsolete")
    stamp = now_ms()
    # The account owner is checked before every cache write.  Provider cache
    # leases fence concurrent chart readers, while this check fences a stale
    # pricing-worker epoch.
    for dataset_id, frame, spec in datasets:
        with transaction() as db:
            lock_owner(db, ownership, epoch, now=stamp)
        series = next((row for row in batch.series if row.spec == spec), None)
        if series is None or not series.result.successful:
            continue
        from .oanda_candles import native_bar

        bars = []
        coverage = []
        for candle in series.candles:
            end = candle.end
            bar = native_bar(start=candle.start, frame=frame,
                parameters=spec.parameters.model_dump(), complete=candle.complete,
                volume=candle.volume, open=candle.open, high=candle.high,
                low=candle.low, close=candle.close)
            bars.append(bar)
            if candle.complete:
                coverage.append([candle.start, end])
        if not bars:
            continue
        try:
            commit_rest_latest(dataset_id, {"bars": bars, "history_boundary": False,
                "coverage": coverage}, stamp)
        except TimeoutError:
            # A foreground native read may briefly own the cache lease. The
            # next cadence repeats the latest snapshot; account ownership
            # itself was already fenced immediately before this attempt.
            log.info("oanda_native_cache_busy dataset=%s", dataset_id)


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
            failure = None
            for future in pending:
                batch = future.result()
                # Both requests are already issued. Observe any second 401
                # even after the first maintenance fault, without committing
                # in-flight successes or submitting another pair.
                if failure and (failure.status == 'unauthorized' or batch.result.status != 'unauthorized'):
                    continue
                if cancelled() and batch.result.status not in ('unauthorized', 'provider_maintenance'):
                    continue
                commit_confirmation(ownership, epoch, batch)
                if batch.result.status in ('unauthorized', 'provider_maintenance'):
                    failure = batch.result
            if failure:
                return failure
    return None


def collect(adapter, ownership, identities, stopped):
    requirements = recovery_requirements(identities)
    epoch = begin_connection(ownership, identities)
    connection_stop = threading.Event()
    lost = threading.Event()
    maintenance_error = []
    intentional_stop = threading.Event()
    closed_stop = threading.Event()
    health_lock = threading.Lock()
    confirmation_fault = [None]

    def report_confirmation(error):
        with health_lock:
            if error is None and lost.is_set():
                return
            confirmation_fault[0] = error
            if error:
                progress(state="degraded", error=error)

    def guard():
        while not stopped.is_set() and not connection_stop.is_set():
            try:
                if not renew(ownership):
                    log.warning("pricing_ownership_lost reason=lease_not_renewed stage=guard epoch=%s", epoch)
                    lost.set()
                    report_confirmation("ownership_lost")
                    return
            except Exception as error:
                # Any inability to prove ownership fences publishing immediately.
                log_failure("pricing_ownership_lost", error, stage="guard", epoch=epoch)
                lost.set()
                report_confirmation(type(error).__name__)
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
                    report_confirmation("ownership_lost")
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
                    report_confirmation(error.status)
                    maintenance_error.append(error)
                    connection_stop.set()
                    return
                report_confirmation(confirmation_error(identities, epoch))
            except TimeoutError as error:
                log_failure("pricing_ownership_lost", error, stage=stage, epoch=epoch)
                lost.set()
                report_confirmation(type(error).__name__)
                return
            except Exception as error:
                log_failure("pricing_maintenance_failed", error, stage=stage, epoch=epoch)
                report_confirmation(type(error).__name__)
            connection_stop.wait(1)

    # SDK REST requests have bounded timeouts. Network waits never hold a DB
    # transaction or the streaming client's single connection.
    thread = threading.Thread(target=copy_context().run, args=(maintenance,),
                              name="oanda-confirmation", daemon=True)
    guardian = threading.Thread(target=copy_context().run, args=(guard,),
                                name="oanda-lease", daemon=True)
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
            with health_lock:
                error_type = "ownership_lost" if lost.is_set() else confirmation_fault[0]
                progress(state="degraded" if error_type else "running", error=error_type)
            stage = "stream"
    except Exception as error:
        result = log_failure("pricing_stream_ended", error, stage=stage, epoch=epoch)
        progress(state="degraded", error=result.status)
        if result.status == "rate_limited":
            seconds = max(1, (result.retry_at - now_ms()) / 1000) if result.retry_at else None
            cooldown("oanda", retry_seconds=seconds)
    else:
        if not (stopped.is_set() or connection_stop.is_set() or lost.is_set()):
            log.info("pricing_stream_closed reason=eof epoch=%s", epoch)
            progress(state="degraded", error=result.status)
    finally:
        connection_stop.set()
        thread.join(timeout=20)
        guardian.join(timeout=6)
        require_stopped((thread, guardian))
        if not lost.is_set():
            try:
                failure = (result if result.status == 'unauthorized' else
                           maintenance_error[-1] if maintenance_error else result)
                delay = (closed_delay(identities) if closed_stop.is_set() and failure.status not in (
                    'unauthorized', 'provider_maintenance') else None)
                if delay is not None:
                    park_closed(ownership, identities, delay)
                else:
                    disconnected(ownership, epoch, identities, failure,
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
            progress(state="waiting_input")
            stopped.wait(wait_delay(adapter.account_id))
            continue
        try:
            # The shared account lease also serializes startup catalog calls.
            if catalog is None:
                with lane('realtime'):
                    catalog = adapter.catalog()
                ensure_catalog(catalog, adapter.account_id, ownership=ownership)
            identities = desired_for_mode(adapter.account_id)
            native = native_specs(adapter.account_id) if settings.oanda_acquisition_mode == "rest_batch" else ()
            delay = closed_delay(identities)
            if delay is not None or (not identities and not native):
                park_closed(ownership, identities, delay if delay is not None else 1)
                progress(state="idle")
                continue
            if settings.oanda_acquisition_mode == 'rest_batch':
                collect_rest(adapter, ownership, identities, stopped, native)
            else:
                collect(adapter, ownership, identities, stopped)
        except Exception as error:
            result = log_failure('pricing_start_failed', error, stage='startup')
            progress(state="degraded", error=result.status)
            try:
                startup_failed(ownership, adapter.account_id, result)
            except TimeoutError:
                pass
            catalog = None


def run_service(stopped):
    if settings.oanda_acquisition_mode == 'stream' and not settings.oanda_stream_enabled:
        while not stopped.is_set():
            progress(state="disabled")
            stopped.wait(5)
        return
    adapter_type = OandaRestBatch if settings.oanda_acquisition_mode == 'rest_batch' else OandaPractice
    adapter = adapter_type(token=settings.oanda_token, account_id=settings.oanda_account_id,
                           proxy=settings.oanda_proxy or settings.market_proxy)
    safe_to_close = True
    try:
        while not stopped.is_set():
            try:
                run(adapter, stopped)
            except Exception as error:
                # Auth/config faults remain quiet and bounded, without account URLs.
                result = log_failure("pricing_start_failed", error, stage="startup")
                progress(state="degraded", error=result.status)
                stopped.wait(settings.oanda_auth_probe_seconds if result.status == 'unauthorized' else 15)
    except UnstoppedThreads:
        safe_to_close = False
        raise
    finally:
        if safe_to_close:
            adapter.close()


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    stopped = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stopped.set())
    run_service(stopped)


if __name__ == "__main__":
    main()
