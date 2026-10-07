from collections import deque
from threading import Event
from types import SimpleNamespace

from alerts.publication_wakeup import PublicationWakeup, notify


class FakeConnection:
    def __init__(self):
        self.pending = deque()
        self.closed = False
        self.commands = []
        self.fail = False

    def execute(self, command):
        self.commands.append(command)

    def notifies(self, **kwargs):
        if self.fail:
            raise OSError('lost listener')
        while self.pending:
            yield self.pending.popleft()

    def close(self):
        self.closed = True


def listener():
    connections = []
    def connect(*args, **kwargs):
        value = FakeConnection()
        connections.append(value)
        return value
    dialect = SimpleNamespace(name='postgresql', create_connect_args=lambda url: ([], {}),
                              loaded_dbapi=SimpleNamespace(connect=connect))
    clock = [0]
    wake = PublicationWakeup(SimpleNamespace(dialect=dialect, url='unused'),
                             monotonic=lambda: clock[0])
    return wake, connections, clock


def test_scan_to_wait_race_keeps_commit_hint_and_registers_before_scan():
    wake, connections, clock = listener()
    with wake:
        assert connections[0].commands == ['LISTEN market_watch_publication_ready']
        wake.prepare()
        # Durable scan found nothing; another process commits before wait.
        connections[0].pending.append(object())
        assert wake.wait(2) == 'notification'
    assert connections[0].closed


def test_old_hints_drain_before_scan_and_busy_yield_does_not_consume_new_hint():
    wake, connections, clock = listener()
    wake.prepare()
    connections[0].pending.append(object())
    wake.prepare()
    assert not connections[0].pending
    connections[0].pending.append(object())
    stop = Event()
    delays = []
    stop.wait = lambda seconds: delays.append(seconds) or False
    assert wake.wait(.005, stop) == 'timer'
    assert delays == [.005] and len(connections[0].pending) == 1
    wake.close()


def test_disconnect_fallback_then_register_before_next_durable_scan():
    wake, connections, clock = listener()
    wake.prepare()
    connections[0].fail = True
    stop = Event()
    delays = []
    stop.wait = lambda seconds: delays.append(seconds) or False
    assert wake.wait(2, stop) == 'fallback'
    assert wake.error == 'OSError' and connections[0].closed
    wake.prepare()
    assert len(connections) == 1
    clock[0] = 2
    wake.prepare()
    assert len(connections) == 2 and wake.error is None
    assert connections[1].commands == ['LISTEN market_watch_publication_ready']
    wake.close()


def test_sqlite_fallback_waits_and_stop_interrupts_without_sql():
    wake = PublicationWakeup(SimpleNamespace(dialect=SimpleNamespace(name='sqlite')))
    with wake:
        stop = Event()
        stop.set()
        assert wake.wait(2, stop) == 'stopped'
        assert wake.connection is None


def test_notify_deduplicates_per_transaction_and_savepoint_rollback_can_retry():
    outer = SimpleNamespace()
    nested = [None]
    statements = []
    db = SimpleNamespace(get_bind=lambda: SimpleNamespace(dialect=SimpleNamespace(name='postgresql')),
                         get_transaction=lambda: outer, get_nested_transaction=lambda: nested[0],
                         execute=lambda *args: statements.append(args))
    notify(db)
    notify(db)
    assert len(statements) == 1
    nested[0] = SimpleNamespace()
    notify(db)
    notify(db)
    # A rolled-back savepoint's marker cannot suppress another savepoint.
    nested[0] = SimpleNamespace()
    notify(db)
    assert len(statements) == 3
