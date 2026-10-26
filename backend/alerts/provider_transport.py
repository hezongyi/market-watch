"""Provider HTTP pools and bounded idle transport maintenance, without market policy."""

import logging
import ssl
import threading
import time
import weakref
from contextlib import ExitStack, contextmanager, nullcontext
from contextvars import ContextVar

import httpx

from .config import settings
from .provider_deadline import deadline_transport, request_deadline

ORIGINS = {'oanda': 'https://api-fxpractice.oanda.com',
           'binance': 'https://data-api.binance.vision',
           'dukascopy': 'https://freeserv.dukascopy.com'}
_LOCK = threading.Lock()
_CLIENTS = {}
_KEYS = weakref.WeakKeyDictionary()
_RETIRED = []
_STOP = threading.Event()
_THREADS = []
IDLE_SECONDS = 20
TIMINGS = ContextVar("provider_acquisition_timings", default=None)


def record_timing(name, started):
    timings = TIMINGS.get()
    if timings is not None:
        timings[name] = timings.get(name, 0) + (time.monotonic() - started) * 1000


def retryable_network_error(error):
    if not isinstance(error, (httpx.ConnectError, httpx.TimeoutException,
                              httpx.ReadError, httpx.RemoteProtocolError)):
        return False
    seen = set()
    current = error
    while current and id(current) not in seen:
        seen.add(id(current))
        if isinstance(current, ssl.SSLCertVerificationError) or "CERTIFICATE_VERIFY_FAILED" in str(current):
            return False
        current = current.__cause__ or current.__context__
    return True


def error_detail(error):
    """Network failures carry a classification, never an upstream URL or credential."""
    if isinstance(error, httpx.HTTPStatusError):
        return f"{type(error).__name__}: HTTP {error.response.status_code}"
    if isinstance(error, httpx.TransportError):
        if not retryable_network_error(error) and isinstance(error, httpx.ConnectError):
            category = "certificate_verification"
        elif "UNEXPECTED_EOF_WHILE_READING" in str(error):
            category = "tls_eof"
        else:
            category = "network_failure"
        return f"{type(error).__name__}: {category}"
    return str(error)[:600] or type(error).__name__


def binance_get(client, url, *, params, deadline, headers=None):
    """At most two read-only attempts; every attempt reacquires the shared lane."""
    from .market_resources import request_slot

    for attempt in range(2):
        phase = "slot"
        route = "proxy" if settings.effective_binance_proxy else "direct"
        phases = {}
        def trace(name, info):
            nonlocal phase
            stage, _, event = name.rpartition(".")
            if event == "started":
                phase = stage
                phases[stage] = time.monotonic()
            elif event in ("complete", "failed") and stage in phases:
                record_timing("network_" + stage.replace(".", "_"), phases.pop(stage))
        started = time.monotonic()
        current = client
        try:
            with request_slot("binance", deadline=deadline):
                record_timing("upstream_slot", started)
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("Binance 请求超过时间预算")
                with activity(client) as current, request_deadline(deadline):
                    timings = TIMINGS.get()
                    attempt_record = {"attempt": attempt + 1}
                    if timings is not None:
                        timings.setdefault("candles_attempts", []).append(attempt_record)
                    http_started = time.monotonic()
                    try:
                        response = current.get(url, params=params, headers=headers,
                            timeout=httpx.Timeout(min(7, remaining), connect=min(5, remaining)),
                            extensions={"trace": trace})
                        attempt_record["status"] = response.status_code
                    except httpx.TransportError as error:
                        attempt_record["error"] = type(error).__name__
                        record_timing("failure_" + type(error).__name__, http_started)
                        raise
                    finally:
                        record_timing("upstream_http", http_started)
            if response.status_code in (502, 503, 504) and not attempt and deadline-time.monotonic() > .25:
                time.sleep(.25)
                continue
            response.raise_for_status()
            return response
        except httpx.TransportError as error:
            if retryable_network_error(error):
                discard_client(current)
            logging.getLogger(__name__).warning(
                "binance_transport_failed type=%s phase=%s route=%s attempt=%s elapsed_ms=%s",
                type(error).__name__, phase, route, attempt+1, round((time.monotonic()-started)*1000))
            if attempt or not retryable_network_error(error) or deadline-time.monotonic() <= .25:
                raise
            time.sleep(.25)
    raise RuntimeError("Binance 请求重试耗尽")


def pooled_client(source):
    if source == 'yahoo':
        raise ValueError('Yahoo SDK 会话只能在 Adapter 操作生命周期内取得')
    from .market_resources import LANE
    if source == 'fxcm':
        raise ValueError('FXCM uses native helper, not HTTP transport')
    proxy = (settings.oanda_proxy if source == 'oanda' else settings.market_proxy
             if source == 'dukascopy' else settings.effective_binance_proxy)
    key = (source, proxy, LANE.get() or 'chart')
    return client_for_key(key)


def client_for_key(key):
    with _LOCK:
        return state_for_key(key)['client']


def state_for_key(key):
    # Callers hold _LOCK so assignment and activity reservation are atomic.
    if key not in _CLIENTS:
        capacity = 2 if key[2] in ('chart', 'pricing') else 1
        limits = httpx.Limits(max_connections=capacity, max_keepalive_connections=capacity,
                             keepalive_expiry=60)
        _CLIENTS[key] = {
            'client': httpx.Client(timeout=7, trust_env=False, limits=limits,
                                 transport=deadline_transport(proxy=key[1] or None, limits=limits)),
            'last_maintained': time.monotonic(), 'active': 0,
        }
        _KEYS[_CLIENTS[key]['client']] = key
    return _CLIENTS[key]


@contextmanager
def activity(client):
    with _LOCK:
        key = _KEYS.get(client)
        state = state_for_key(key) if key is not None else None
        if state:
            client = state['client']
            state['active'] += 1
    try:
        yield client
    finally:
        if state:
            with _LOCK:
                state['active'] -= 1
            close_retired()


def discard_client(client):
    """Rotate a failed pool; existing readers keep their generation until done."""
    with _LOCK:
        key = _KEYS.get(client)
        state = _CLIENTS.get(key)
        if state and state['client'] is client:
            _CLIENTS.pop(key)
            _RETIRED.append(state)
            # Retain an empty replacement so idle maintenance can reestablish
            # transport after a startup/heartbeat failure without a chart read.
            state_for_key(key)
    close_retired()


def retire_client(client):
    """Retire an owned pool without creating an unused replacement on shutdown."""
    with _LOCK:
        key = _KEYS.get(client)
        state = _CLIENTS.pop(key, None)
        if state:
            _RETIRED.append(state)
    close_retired()


def close_retired():
    with _LOCK:
        ready = [state for state in _RETIRED if state['active'] == 0]
        for state in ready:
            _RETIRED.remove(state)
    for state in ready:
        state['client'].close()


def warm_connections(client, source, *, seconds=4, busy=None, reserved=False):
    """Touch both chart connections without reading candles or growing the pool.

    Keep each HEAD response open until the next socket is acquired; ordinary
    sequential HEAD calls otherwise reuse only the first HTTP/1.1 connection.
    Consume the empty responses before closing so HTTPcore can retain sockets.
    """
    from .market_resources import lane, request_slot

    deadline = time.monotonic() + seconds
    with ExitStack() as opened:
        responses = []
        try:
            for _ in range(2):
                if busy and busy(source):
                    return False
                reservation = request_slot(
                    source, deadline=deadline,
                    cancelled=(lambda: busy(source)) if busy else None,
                ) if reserved else nullcontext()
                with lane('history'), reservation:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0 or (busy and busy(source)):
                        return False
                    responses.append(opened.enter_context(client.stream(
                        'HEAD', ORIGINS[source], timeout=min(1 if reserved else 4, remaining),
                    )))
            return True
        finally:
            for response in responses:
                response.read()


def maintain(source, busy):
    if busy(source):
        return False
    with _LOCK:
        state = next((value for (kind, _, kind_lane), value in _CLIENTS.items()
                      if kind == source and kind_lane == 'chart'), None)
        # Traffic may keep one socket hot while the unused second one expires.
        # Recent reads cannot postpone maintenance of unused sockets.
        if not state or state['active'] or time.monotonic() - state['last_maintained'] < IDLE_SECONDS:
            return False
        state['active'] += 1
        state['last_maintained'] = time.monotonic()
    try:
        # Each HEAD gets the existing one-per-second background reservation.
        # Check foreground work between sockets; never take its quota or retry.
        return warm_connections(state['client'], source, seconds=2, busy=busy, reserved=True)
    except (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout):
        discard_client(state['client'])
        return False
    except (httpx.HTTPError, TimeoutError):
        return False
    finally:
        with _LOCK:
            state['active'] -= 1
            state['last_maintained'] = time.monotonic()
        close_retired()


def start(busy):
    if _THREADS:
        return
    _STOP.clear()
    def worker(source):
        while not _STOP.wait(10):
            try:
                maintain(source, busy)
            except Exception:
                # Maintenance must not make a healthy API unavailable. Actual
                # candle requests preserve their normal observable failure path.
                import logging
                logging.getLogger(__name__).exception('Provider transport maintenance failed for %s', source)
    for source in ORIGINS:
        thread = threading.Thread(target=worker, args=(source,), name='provider-transport-' + source,
                                  daemon=True)
        _THREADS.append(thread)
        thread.start()


def close_clients():
    from .provider_fxcm import close_session as close_fxcm
    from .provider_yahoo import close_session
    close_fxcm()
    close_session()
    _STOP.set()
    for thread in _THREADS:
        thread.join()
    _THREADS.clear()
    with _LOCK:
        clients = [value['client'] for value in (*_CLIENTS.values(), *_RETIRED)]
        _CLIENTS.clear()
        _RETIRED.clear()
    for client in clients:
        client.close()
