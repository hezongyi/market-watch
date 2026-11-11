"""History-only wakeup hints. Task rows and cache snapshots remain authoritative.

One dedicated LISTEN connection per process, outside the business connection pool.
Lost hints fall back to the existing bounded scan/read; payloads contain only IDs.
"""

import logging
import threading
from contextlib import contextmanager

from sqlalchemy import event, text

log = logging.getLogger(__name__)
CHANNEL = "mw_native_history_v1"
_lock = threading.Lock()
_callbacks = set()
_stop = threading.Event()
_thread = None


def _dispatch(ident):
    with _lock:
        callbacks = tuple(_callbacks)
    for callback in callbacks:
        try:
            callback(ident)
        except Exception:
            log.warning("History wakeup observer unavailable")


def notify(db, ident):
    if db.get_bind().dialect.name == "postgresql":
        db.execute(text("SELECT pg_notify(:channel, :ident)"), {"channel": CHANNEL, "ident": ident})
    # Also wake same-process listeners, but only after a successful commit.
    event.listen(db, "after_commit", lambda _: _dispatch(ident), once=True)


def _listen(url):
    import psycopg
    while not _stop.is_set():
        try:
            with psycopg.connect(url, autocommit=True, connect_timeout=3,
                                 application_name="mw-native-history-listener") as connection:
                connection.execute("LISTEN " + CHANNEL)
                while not _stop.is_set():
                    for notification in connection.notifies(timeout=0.5, stop_after=64):
                        _dispatch(notification.payload)
        except Exception as exc:
            # Exceptions can contain connection strings: log the type only.
            log.warning("History listener reconnect type=%s", type(exc).__name__)
            _stop.wait(1)


def start():
    global _thread
    from . import storage
    with _lock:
        if _thread is not None and _thread.is_alive():
            return
        with storage.Session() as db:
            engine = db.get_bind()
        if engine.dialect.name != "postgresql":
            return
        url = engine.url.set(drivername="postgresql").render_as_string(hide_password=False)
        _stop.clear()
        _thread = threading.Thread(target=_listen, args=(url,), name="native-history-listener", daemon=True)
        _thread.start()


@contextmanager
def watch(callback):
    with _lock:
        _callbacks.add(callback)
    try:
        start()
        yield
    finally:
        with _lock:
            _callbacks.discard(callback)


def close():
    global _thread
    _stop.set()
    thread = _thread
    if thread:
        thread.join(timeout=5)
        if thread.is_alive():
            raise RuntimeError("History listener did not stop")
    _thread = None
