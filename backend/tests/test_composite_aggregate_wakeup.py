"""A committed composite input wakes the period worker; polling is only a floor."""

from types import SimpleNamespace

import pytest
from alerts import composite_aggregate_worker as worker
from alerts import composite_aggregates as cache
from alerts import publication_wakeup
from alerts.storage import CompositeAggregateTask, CompositeInputEvent, CompositeRevision
from sqlalchemy import select
from test_composite_chart import populated


class Listener:
    """Fake commit listener: hints end a wait early, a lost one ends it at the floor."""

    def __init__(self, clock, script=()):
        self.clock, self.script, self.waits, self.prepares = clock, list(script), [], 0
        self.entered = 0

    def __enter__(self):
        self.entered += 1
        return self

    def __exit__(self, *args):
        self.entered -= 1

    def prepare(self):
        self.prepares += 1

    def wait(self, seconds, stop):
        # A queued hint returns without consuming the timeout, exactly like
        # PublicationWakeup.notifies(stop_after=1).
        self.waits.append(seconds)
        outcome = self.script.pop(0) if self.script else 'timer'
        self.clock[0] += min(seconds, .02) if outcome == 'notification' else seconds
        return outcome


def harness(monkeypatch, results, script):
    """Run the worker on a virtual clock; stop after every scripted scan."""
    clock, scans = [0.0], []
    listener = Listener(clock, script)
    stop = SimpleNamespace(is_set=lambda: len(scans) >= len(results))

    def sleep(seconds):
        assert seconds > 0, 'A wakeup must never produce a zero-wait spin'
        clock[0] += seconds

    def tick(**_kwargs):
        scans.append(clock[0])
        return results[len(scans) - 1]

    monkeypatch.setattr(worker, 'aggregate_tick', tick)
    monkeypatch.setattr(worker, 'runtime_error', lambda: None)
    monkeypatch.setattr(worker, 'progress', lambda **_kwargs: None)
    stop.wait = sleep
    worker.run(stop, wakeup=listener)
    return clock[0], scans, listener


def test_input_hint_starts_the_scan_before_the_idle_floor(monkeypatch):
    # The first scan finds nothing; the confirmed minute commits .02 s into the
    # idle wait, so the next scan must follow that hint instead of the floor.
    elapsed, scans, listener = harness(monkeypatch, [False, True, False],
                                      ['notification', 'timer'])
    assert scans[0] == 0.0
    assert scans[1] == pytest.approx(.02 + worker.BUSY_YIELD)
    assert scans[1] < worker.IDLE_FLOOR, 'The hint must beat the polling floor'
    # Every idle round still offers the bounded floor to a missing listener.
    assert listener.waits == [worker.IDLE_FLOOR, worker.IDLE_FLOOR]
    assert listener.prepares == 3 and listener.entered == 0


def test_lost_listener_falls_back_to_the_bounded_idle_poll(monkeypatch):
    elapsed, scans, listener = harness(monkeypatch, [False, False, False],
                                      ['fallback', 'fallback', 'timer'])
    assert scans == pytest.approx([0.0, worker.IDLE_FLOOR, 2 * worker.IDLE_FLOOR])
    assert listener.waits == [worker.IDLE_FLOOR] * 3


def test_error_backoff_is_a_plain_wait_that_hints_cannot_cancel(monkeypatch):
    waits, listener = [], Listener([0.0], ['notification'])
    stop = SimpleNamespace()
    stop.is_set = lambda: bool(waits)

    def fail(**_kwargs):
        raise TimeoutError('controlled database failure')

    monkeypatch.setattr(worker, 'aggregate_tick', fail)
    monkeypatch.setattr(worker, 'progress', lambda **_kwargs: None)
    stop.wait = waits.append
    worker.run(stop, wakeup=listener)
    assert waits == [2]
    assert listener.waits == [], 'A queued hint must not shorten the error backoff'


def test_hint_storm_costs_one_bounded_yield_per_empty_round(monkeypatch):
    elapsed, scans, listener = harness(monkeypatch, [False, False, False],
                                      ['notification'] * 3)
    # Unrelated chart/display commits keep interrupting the idle wait. Each empty
    # round still yields BUSY_YIELD exactly once, so the loop cannot spin.
    assert scans == pytest.approx([0.0, .02 + worker.BUSY_YIELD,
                                  .04 + 2 * worker.BUSY_YIELD])
    assert len(listener.waits) == 3
    assert all(later > earlier for earlier, later in zip(scans, scans[1:]))


def drain(revision, frame):
    for _ in range(100):
        if not cache.aggregate_tick(revision, frame):
            return
    raise AssertionError('Period task did not finish')


def latest_minute(database, revision):
    with database() as db:
        return max(item['start'] for event in db.scalars(select(CompositeInputEvent).where(
            CompositeInputEvent.revision_id == revision)) for item in event.input_manifest['minutes'])


def confirm(database, revision, *, start=None, observed=0):
    """Record and pin one confirmed minute; start defaults to one past the head."""
    from alerts.composite_inputs import apply_minutes
    from alerts.confirmed_minutes import record
    from alerts.market_contracts import DatasetIdentity
    from alerts.storage import MarketDataset, RealtimeMapping
    from test_market_contracts import batch, minute

    with database.begin() as db:
        target = db.get(MarketDataset, db.get(RealtimeMapping,
            db.get(CompositeRevision, revision).mapping_id).target_dataset_id)
        at = latest_minute(database, revision) + 60000 if start is None else start
        return apply_minutes(db, record(db, batch(
            identity=DatasetIdentity.model_validate(target.identity),
            window_start=at, window_end=at + 60000, checkpoint=at + 60000,
            observed_at=max(observed, at + 60000), volume_kind='price_count',
            volume_unit='quotes', rows=(minute(at, volume="3"),))))


def test_changed_input_publishes_one_hint_and_unchanged_input_publishes_none(database, monkeypatch):
    _, revision, _ = populated(database, monkeypatch)
    drain(revision, 'M1')
    hints = []
    monkeypatch.setattr(publication_wakeup, 'notify', lambda db: hints.append(db.in_transaction()))
    assert confirm(database, revision)[0]['input_revision'] == 2
    # The hint rides the same transaction that writes the input, so PostgreSQL
    # delivers it only if that transaction commits.
    assert hints == [True]
    # Re-confirming the same minute changes no input; waking the worker for it
    # would only produce an empty scan.
    at = latest_minute(database, revision)
    assert confirm(database, revision, start=at, observed=at + 600000) == []
    assert len(hints) == 1


def test_failed_hint_cannot_roll_back_confirmed_input(database, monkeypatch):
    _, revision, _ = populated(database, monkeypatch)
    drain(revision, 'M1')

    def broken(_db):
        raise OSError('listener channel unavailable')

    monkeypatch.setattr(publication_wakeup, 'notify', broken)
    assert confirm(database, revision)[0]['input_revision'] == 2
    with database() as db:
        # The savepoint discarded only the hint: the pinned input survives and
        # the session is not left in a failed transaction.
        assert db.scalar(select(CompositeInputEvent).where(
            CompositeInputEvent.revision_id == revision,
            CompositeInputEvent.input_revision == 2)) is not None
    # The worker still finds the new input through its durable waterline.
    assert cache.aggregate_tick(revision, 'M1')
    assert cache.aggregate_tick(revision, 'M1') is False


def test_empty_wakeup_keeps_the_empty_scan_result_and_cannot_reprocess(database, monkeypatch):
    _, revision, _ = populated(database, monkeypatch)
    drain(revision, 'M1')
    with database.begin() as db:
        published = db.get(CompositeAggregateTask, (revision, 'M1')).applied_input_revision
    # A hint without due work changes nothing: same False, same waterline.
    assert cache.aggregate_tick(revision, 'M1', runtime_only=False) is False
    assert cache.aggregate_tick(revision, 'M1', runtime_only=False) is False
    with database.begin() as db:
        task = db.get(CompositeAggregateTask, (revision, 'M1'))
        assert task.applied_input_revision == published
        assert task.lease_token is None and task.lease_until == 0


def test_duplicate_commit_after_wakeup_is_still_rejected(database, monkeypatch):
    _, revision, _ = populated(database, monkeypatch)
    drain(revision, 'M1')
    confirm(database, revision)
    first = cache.claim(revision, 'M1')
    bars = cache.build(first)
    cache.commit(first, bars)
    # A second consumer holding the same claim (a wakeup that raced another
    # worker) cannot publish twice: the lease token and offset are consumed.
    with pytest.raises(TimeoutError):
        cache.commit(first, bars)
    assert cache.aggregate_tick(revision, 'M1') is False
