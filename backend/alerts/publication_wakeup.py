"""Commit-delivered queue hints; durable generations remain the source of truth."""

import logging
import time
from threading import Event

from sqlalchemy import text

log = logging.getLogger(__name__)
CHANNEL = 'market_watch_publication_ready'
STREAM_CHANNEL = 'market_watch_stream_demand'
ALERT_CHANNEL = 'market_watch_alert_demand'
NOTICE_CHANNEL = 'market_watch_notice_ready'
HISTORY_CHANNEL = 'market_watch_history_work'
COMPOSITE_CHANNEL = 'market_watch_composite_input'
PROVIDER_CHANNEL = 'market_watch_provider_demand'


def notify_connection(connection, channel):
    """Core source hooks share the same commit/rollback delivery guarantee."""
    if connection.dialect.name == 'postgresql':
        connection.execute(text("SELECT pg_notify(:channel, '')"), {'channel': channel})


def notify(db, channel=CHANNEL):
    """PostgreSQL delivers this hint only if the input transaction commits.

    Identical channel/payload notifications coalesce within a transaction,
    including requests for different frames. Savepoint rollbacks discard hints.
    """
    if db.get_bind().dialect.name == 'postgresql':
        transaction = db.get_nested_transaction() or db.get_transaction()
        sent = getattr(transaction, '_publication_wakeup_sent', set())
        if channel in sent:
            return
        db.execute(text("SELECT pg_notify(:channel, '')"), {'channel': channel})
        transaction._publication_wakeup_sent = sent | {channel}


class PublicationWakeup:
    """One independent LISTEN connection per worker, registered before scanning.

    Disconnections degrade to the caller's bounded polling delay. The listener
    never consumes a slot in the application transaction connection pool.
    """

    def __init__(self, engine=None, *, monotonic=time.monotonic, channel=CHANNEL, channels=None):
        selected = tuple(dict.fromkeys(channels if channels is not None else (channel,)))
        if not selected or any(value not in (CHANNEL, STREAM_CHANNEL, ALERT_CHANNEL, NOTICE_CHANNEL, HISTORY_CHANNEL, COMPOSITE_CHANNEL, PROVIDER_CHANNEL) for value in selected):
            raise ValueError('Unknown worker wakeup channel')
        if engine is None:
            from .storage import engine
        self.engine = engine
        self.channel = channel
        self.channels = selected
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
                for channel in self.channels:
                    self.connection.execute('LISTEN ' + channel)
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

        No SQL is executed while waiting. stop is checked at most every 500ms.
        """
        stop = stop if stop is not None else Event()
        if seconds < .05 or self.connection is None:
            stopped = stop.wait(min(seconds, 2) if self.connection is None else seconds)
            return 'stopped' if stopped else 'fallback' if self.connection is None else 'timer'
        deadline = self.monotonic() + seconds
        while not stop.is_set():
            remaining = deadline - self.monotonic()
            if remaining <= 0:
                return 'timer'
            try:
                if list(self.connection.notifies(timeout=min(.5, remaining), stop_after=1)):
                    return 'notification'
            except Exception as error:
                self._failed(error)
                stopped = stop.wait(min(2, max(0, deadline - self.monotonic())))
                return 'stopped' if stopped else 'fallback'
        return 'stopped'
