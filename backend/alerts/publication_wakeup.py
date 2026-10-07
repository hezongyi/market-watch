"""Commit-delivered queue hints; durable generations remain the source of truth."""

import logging
import time
from threading import Event

from sqlalchemy import text

log = logging.getLogger(__name__)
CHANNEL = 'market_watch_publication_ready'


def notify(db):
    """PostgreSQL delivers this hint only if the input transaction commits.

    Identical channel/payload notifications coalesce within a transaction,
    including requests for different frames. Savepoint rollbacks discard hints.
    """
    if db.get_bind().dialect.name == 'postgresql':
        transaction = db.get_nested_transaction() or db.get_transaction()
        if getattr(transaction, '_publication_wakeup_sent', False):
            return
        db.execute(text("SELECT pg_notify(:channel, '')"), {'channel': CHANNEL})
        transaction._publication_wakeup_sent = True


class PublicationWakeup:
    """One independent LISTEN connection per worker, registered before scanning.

    Disconnections degrade to the caller's bounded polling delay. The listener
    never consumes a slot in the application transaction connection pool.
    """

    def __init__(self, engine=None, *, monotonic=time.monotonic):
        if engine is None:
            from .storage import engine
        self.engine = engine
        self.monotonic = monotonic
        self.connection = None
        self.retry_at = 0
        self.error = None

    def __enter__(self):
        self.prepare()
        return self

    def __exit__(self, *args):
        self.close()

    def close(self):
        if self.connection is not None:
            try:
                self.connection.close()
            except Exception:
                pass
            self.connection = None

    def _failed(self, error):
        self.close()
        self.error = type(error).__name__
        self.retry_at = self.monotonic() + 2
        log.warning('publication_listener_unavailable type=%s fallback_seconds=2', self.error)

    def prepare(self):
        """Register/reconnect, then discard old hints BEFORE the durable scan.

        Hints arriving during/after the scan stay queued for wait(), closing the
        empty-scan-to-sleep race. Every reconnect precedes a new durable scan.
        """
        if self.engine.dialect.name != 'postgresql':
            return
        try:
            if self.connection is None:
                if self.monotonic() < self.retry_at:
                    return
                args, kwargs = self.engine.dialect.create_connect_args(self.engine.url)
                kwargs.update(connect_timeout=2, application_name='market-watch-publication-listener')
                self.connection = self.engine.dialect.loaded_dbapi.connect(*args, **kwargs)
                self.connection.autocommit = True
                self.connection.execute('LISTEN ' + CHANNEL)
                if self.error:
                    log.info('publication_listener_reconnected')
                self.error = None
            # Poll once without blocking; PostgreSQL may deliver several hints
            # in a packet. Clearing before the scan cannot lose durable work.
            list(self.connection.notifies(timeout=0))
        except Exception as error:
            self._failed(error)

    def wait(self, seconds, stop=None):
        """Interrupt idle/due waits on hints; preserve short busy yields.

        No SQL is executed while waiting. stop is checked at most every100ms.
        """
        stop = stop if stop is not None else Event()
        if seconds < .05 or self.connection is None:
            stopped = stop.wait(seconds)
            return 'stopped' if stopped else 'fallback' if self.connection is None else 'timer'
        deadline = self.monotonic() + seconds
        while not stop.is_set():
            remaining = deadline - self.monotonic()
            if remaining <= 0:
                return 'timer'
            try:
                if list(self.connection.notifies(timeout=min(.1, remaining), stop_after=1)):
                    return 'notification'
            except Exception as error:
                self._failed(error)
                stopped = stop.wait(max(0, deadline - self.monotonic()))
                return 'stopped' if stopped else 'fallback'
        return 'stopped'
