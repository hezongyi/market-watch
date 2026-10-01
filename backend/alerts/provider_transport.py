"""Provider HTTP pools and bounded idle transport maintenance, without market policy."""

import threading
import time
import weakref
from contextlib import contextmanager

import httpx

from .config import settings

ORIGINS = {'oanda': 'https://api-fxpractice.oanda.com',
           'binance': 'https://data-api.binance.vision'}
_LOCK = threading.Lock()
_CLIENTS = {}
_KEYS = weakref.WeakKeyDictionary()
_RETIRED = []
_STOP = threading.Event()
_THREADS = []
IDLE_SECONDS = 20


def pooled_client(source):
    from .market_resources import LANE
    proxy = settings.oanda_proxy if source == 'oanda' else settings.effective_binance_proxy
    key = (source, proxy, LANE.get() or 'chart')
    return client_for_key(key)


def client_for_key(key):
    with _LOCK:
        return state_for_key(key)['client']


def state_for_key(key):
    # Callers hold _LOCK so assignment and activity reservation are atomic.
    if key not in _CLIENTS:
        capacity = 2 if key[2] == 'chart' else 1
        _CLIENTS[key] = {
            'client': httpx.Client(timeout=7, proxy=key[1] or None, trust_env=False,
                                 limits=httpx.Limits(max_connections=capacity,
                                                    max_keepalive_connections=capacity,
                                                    keepalive_expiry=60)),
            'last_used': time.monotonic(), 'active': 0,
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
            state['last_used'] = time.monotonic()
    try:
        yield client
    finally:
        if state:
            with _LOCK:
                state['active'] -= 1
                state['last_used'] = time.monotonic()
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


def close_retired():
    with _LOCK:
        ready = [state for state in _RETIRED if state['active'] == 0]
        for state in ready:
            _RETIRED.remove(state)
    for state in ready:
        state['client'].close()


def maintain(source, busy):
    if busy(source):
        return False
    with _LOCK:
        state = next((value for (kind, _, kind_lane), value in _CLIENTS.items()
                      if kind == source and kind_lane == 'chart'), None)
        if not state or state['active'] or time.monotonic() - state['last_used'] < IDLE_SECONDS:
            return False
        state['active'] += 1
        state['last_used'] = time.monotonic()
    try:
        # Reuse the background reservation, never take foreground/realtime slots.
        from .market_resources import lane, request_slot
        deadline = time.monotonic() + 2
        with lane('history'), request_slot(source, deadline=deadline):
            remaining = deadline - time.monotonic()
            if remaining <= 0 or busy(source):
                return False
            state['client'].head(ORIGINS[source], timeout=min(1, remaining))
        return True
    except (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout):
        discard_client(state['client'])
        return False
    except (httpx.HTTPError, TimeoutError):
        return False
    finally:
        with _LOCK:
            state['active'] -= 1
            state['last_used'] = time.monotonic()
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
