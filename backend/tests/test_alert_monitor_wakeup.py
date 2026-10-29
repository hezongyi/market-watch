"""Commit wakeups preserve error backoff and overrun cadence."""

from threading import Event

import pytest
from alerts import alert_monitor, chart_alert_worker, publication_wakeup


class Listener:
    """Fake listener whose waits are cut short by one commit notification."""

    def __init__(self, clock, period, events):
        self.clock, self.period, self.events = clock, period, events
        self.connection = None

    def __enter__(self):
        self.events.append(('enter', None))
        return self

    def __exit__(self, *args):
        self.events.append(('exit', None))

    def prepare(self):
        self.events.append(('prepare', self.clock[0]))

    def wait(self, seconds, stop):
        self.events.append(('wait', seconds))
        assert seconds > 0, 'A wakeup must never produce a zero-wait turn'
        assert seconds <= self.period + 1e-9, 'Cadence must not stretch past one period'
        self.clock[0] += min(seconds, .1)
        return 'notification'


def test_commit_notification_starts_the_next_turn_before_the_period(monkeypatch):
    stop, clock, events, starts = Event(), [0.0], [], []
    listener = Listener(clock, .25, events)

    def step(**kwargs):
        starts.append(clock[0])
        events.append(('step', clock[0]))
        clock[0] += .05
        if len(starts) == 3:
            stop.set()
        return 1

    monkeypatch.setattr(chart_alert_worker, 'step', step)
    alert_monitor.run(stop, period=.25, monotonic=lambda: clock[0], wakeup=listener,
                      report_health=lambda *args, **kwargs: None)
    # Without notifications this cadence is [0, .25, .5]; each commit arrives
    # .1 s into the wait, so turns start .05 s before their period boundary.
    assert starts == pytest.approx([0.0, .15, .3])
    assert [kind for kind, _ in events] == [
        'enter', 'prepare', 'step', 'wait', 'prepare', 'step', 'wait',
        'prepare', 'step', 'wait', 'exit']


def test_default_listener_is_created_and_prepared_before_each_scan(monkeypatch):
    stop, clock, events, created = Event(), [0.0], [], []

    class Default(Listener):
        def __init__(self, **kwargs):
            created.append(kwargs)
            super().__init__(clock, .25, events)

        def prepare(self):
            super().prepare()
            if len([kind for kind, _ in events if kind == 'step']) >= 2:
                stop.set()

    def monotonic():
        return clock[0]

    monkeypatch.setattr(publication_wakeup, 'PublicationWakeup', Default)
    def step(**kwargs):
        events.append(('step', clock[0]))
        return 1

    monkeypatch.setattr(chart_alert_worker, 'step', step)
    alert_monitor.run(stop, period=.25, monotonic=monotonic,
                      report_health=lambda *args, **kwargs: None)
    # One listener for the whole run, sharing the monitor's clock for its waits.
    assert created == [dict(monotonic=monotonic)]
    # The commit listener is prepared before every scan and reused afterwards.
    assert [kind for kind, _ in events] == [
        'enter', 'prepare', 'step', 'wait', 'prepare', 'step', 'wait',
        'prepare', 'step', 'wait', 'exit']


def test_fallback_without_listening_connection_keeps_the_period_cadence(monkeypatch):
    stop, clock, starts = Event(), [0.0], []

    def step(**kwargs):
        starts.append(clock[0])
        clock[0] += .1

    def wait(seconds):
        assert seconds > 0, 'No catch-up storm or overloaded busy loop'
        clock[0] += seconds
        if len(starts) == 3:
            stop.set()

    monkeypatch.setattr(chart_alert_worker, 'step', step)
    monkeypatch.setattr(stop, 'wait', wait)
    alert_monitor.run(stop, period=.25, monotonic=lambda: clock[0], on_turn=lambda turn: None,
                      report_health=lambda *args, **kwargs: None)
    assert starts == pytest.approx([0.0, .25, .5])


def test_non_postgres_wakeup_degrades_without_a_listening_connection():
    from alerts.publication_wakeup import PublicationWakeup
    from alerts.storage import engine

    if engine.dialect.name == 'postgresql':
        pytest.skip('The fallback path only applies off PostgreSQL')
    listener = PublicationWakeup()
    with listener:
        assert listener.connection is None and listener.error is None
        stop = Event()
        assert listener.wait(.05, stop) == 'fallback'
        stop.set()
        assert listener.wait(.2, stop) == 'stopped'
    assert listener.connection is None

def test_notifications_without_new_input_keep_the_period_floor(monkeypatch):
    stop, clock, starts = Event(), [0.0], []

    class Storm(Listener):
        """Hints keep arriving from display/chart commits that advance nothing."""

        def wait(self, seconds, stop):
            self.events.append(('wait', seconds))
            assert seconds > 0, 'A wakeup must never produce a zero-wait turn'
            assert seconds <= self.period + 1e-9, 'Cadence must not stretch past one period'
            self.clock[0] += min(seconds, .02)
            return 'notification'

    def step(**kwargs):
        starts.append(clock[0])
        clock[0] += .05
        if len(starts) == 3:
            stop.set()
        return 0

    def sleep(seconds):
        clock[0] += seconds

    monkeypatch.setattr(chart_alert_worker, 'step', step)
    monkeypatch.setattr(stop, 'wait', sleep)
    alert_monitor.run(stop, period=.25, monotonic=lambda: clock[0], wakeup=Storm(clock, .25, []),
                      report_health=lambda *args, **kwargs: None)
    # Empty turns are never pulled forward by a hint: even a hint storm leaves
    # the durable period as the only start signal.
    assert starts == pytest.approx([0.0, .25, .5])


def test_empty_wakeup_degrades_to_one_bounded_sleep(monkeypatch):
    """A hint storm must cost one sleep per round, never a spin inside the wait."""
    stop, clock, events, starts = Event(), [0.0], [], []
    listener_waits = []

    class HintStorm:
        """Every listener wait returns a queued hint at once, advancing nothing.

        Display and chart commits publish hints like this: the wait returns
        immediately without consuming its timeout.
        """

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def prepare(self):
            events.append(('prepare', clock[0]))

        def wait(self, seconds, stop):
            events.append(('listener_wait', seconds))
            listener_waits.append(clock[0])
            assert len(listener_waits) <= len(starts) + 1, (
                'Hints must not re-enter the listener within one round')
            return 'notification'

    def sleep(seconds):
        events.append(('stop_wait', seconds))
        clock[0] += seconds

    def step(**kwargs):
        starts.append(clock[0])
        events.append(('step', clock[0]))
        clock[0] += .05
        if len(starts) == 3:
            stop.set()
        return 0

    monkeypatch.setattr(chart_alert_worker, 'step', step)
    monkeypatch.setattr(stop, 'wait', sleep)
    alert_monitor.run(stop, period=.25, monotonic=lambda: clock[0], wakeup=HintStorm(),
                      report_health=lambda *args, **kwargs: None)
    # Cadence is unaffected by the storm: each round still starts one period apart.
    assert starts == pytest.approx([0.0, .25, .5])
    # Exactly one listener wait per round: the storm never re-enters the listener.
    assert len(listener_waits) == 3
    assert [kind for kind, _ in events] == [
        'prepare', 'step', 'listener_wait', 'stop_wait'] * 3


@pytest.mark.parametrize('period,cost,failure,expected', [
    (.25, .01, 'partial', [0, .26, .52]),
    (.75, .01, 'partial', [0, .76, 1.52]),
    (.25, .01, 'raised', [0, .26, .52]),
    (.25, .30, None, [0, .50, 1.00]),
    (.25, .50, None, [0, .75, 1.50]),
    (.75, 1.30, None, [0, 1.50, 3.00]),
])
def test_queued_publications_cannot_interrupt_error_or_overrun_waits(
        monkeypatch, period, cost, failure, expected):
    from types import SimpleNamespace

    stop, clock, starts, waits = Event(), [0.0], [], []

    class Connection:
        def notifies(self, *, timeout, stop_after=None):
            # prepare() drains old hints, but publications during the scan
            # remain queued when the real PublicationWakeup enters wait().
            return iter([object()] if timeout > 0 else [])

        def close(self):
            pass

    wake = publication_wakeup.PublicationWakeup(
        SimpleNamespace(dialect=SimpleNamespace(name='postgresql')),
        monotonic=lambda: clock[0])
    wake.connection = Connection()

    def step(**kwargs):
        starts.append(clock[0])
        clock[0] += cost
        if len(starts) == 3:
            stop.set()
        if failure == 'raised':
            raise ValueError('Failed scan')
        if failure == 'partial':
            kwargs['on_error']('ValueError')
        return 1

    def wait(seconds):
        waits.append(seconds)
        clock[0] += seconds
        return stop.is_set()

    monkeypatch.setattr(chart_alert_worker, 'step', step)
    monkeypatch.setattr(stop, 'wait', wait)
    alert_monitor.run(stop, period=period, monotonic=lambda: clock[0], wakeup=wake,
                      report_health=lambda *args, **kwargs: None)
    assert starts == pytest.approx(expected)
    assert all(seconds > 0 for seconds in waits)


def test_ownership_loss_closes_listener_without_retry_or_stopped_health(monkeypatch):
    from alerts.runtime_health import RuntimeOwnershipLost

    stop, clock, events, reports = Event(), [0.0], [], []

    def step(**kwargs):
        raise RuntimeOwnershipLost('Replaced owner')

    monkeypatch.setattr(chart_alert_worker, 'step', step)
    with pytest.raises(RuntimeOwnershipLost):
        alert_monitor.run(stop, wakeup=Listener(clock, .25, events),
                          monotonic=lambda: clock[0],
                          report_health=lambda *args, **kwargs: reports.append((args, kwargs)))
    assert events == [('enter', None), ('prepare', 0.0), ('exit', None)]
    assert reports == []
