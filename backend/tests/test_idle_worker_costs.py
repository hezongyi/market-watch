"""Idle scans stay bounded; committed demand and real content retain fast paths."""
from types import SimpleNamespace

from alerts import aggregate_observation, notification_center_worker, provider_service
from alerts.storage import Bar, Instrument, instant
from sqlalchemy import event, select


class Stop:
    def __init__(self, turns=3):
        self.delays = []
        self.turns = turns

    def is_set(self):
        return len(self.delays) >= self.turns

    def wait(self, seconds):
        self.delays.append(seconds)
        return self.is_set()


class Wake:
    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def prepare(self):
        pass

    def wait(self, seconds, stop):
        stop.wait(seconds)


def test_projection_idle_scan_backs_off_but_backlog_drains_fast(monkeypatch):
    from alerts import publication_wakeup, runtime_health

    monkeypatch.setattr(publication_wakeup, 'PublicationWakeup', lambda **kw: Wake())
    monkeypatch.setattr(runtime_health, 'progress', lambda **kw: None)
    monkeypatch.setattr(notification_center_worker, 'report', lambda *a, **kw: None)
    counts = iter([0, 0, 100, 0])
    monkeypatch.setattr(notification_center_worker, 'once', lambda: next(counts))
    stop = Stop(4)
    notification_center_worker.run_projection(stop)
    assert stop.delays == [2, 2, .02, 2]


def test_completed_day_observation_groups_by_bucket_not_by_every_minute(database, monkeypatch):
    # A full D1 observation is a common idle write. Its 1440 rows must still
    # all be compared, but calendar/DST boundaries only need resolving once.
    now = 86400000 + 1000
    with database.begin() as db:
        inst = db.get(Instrument, 'BTCUSDT')
        db.add(Bar(instrument_id=inst.id, timeframe='D1', start=0, end=86400000,
                   open=10, high=12, low=9, close=11, complete=True, observed_at=1))
    rows = [SimpleNamespace(start=i*60000, end=(i+1)*60000, open=10, high=12,
                low=9, close=11, complete=True, volume=None, volume_complete=False,
                observed_at=now) for i in range(1440)]
    calls = []
    original = aggregate_observation.bucket_bounds

    def bounds(*args):
        calls.append(args)
        return original(*args)

    monkeypatch.setattr(aggregate_observation, 'bucket_bounds', bounds)
    with database.begin() as db:
        assert not aggregate_observation.refresh(db, db.get(Instrument, 'BTCUSDT'),
                   {instant(row.start) for row in rows}, 'D1', rows)
        day = db.scalar(select(Bar).where(Bar.timeframe == 'D1', Bar.instrument_id == 'BTCUSDT'))
        assert day.observed_at == now and day.revision == 1
    assert len(calls) <= 2


def test_cleanup_does_not_count_bars_when_every_candidate_is_expired(database):
    from test_provider_cache import META, page, seed

    key = seed(META, 'M5', 10000, page(1000, 10000))
    with database.begin() as db:
        from alerts.storage import ProviderDataset
        db.get(ProviderDataset, key).accessed_at = 0
    statements = []
    engine = database.kw['bind']

    def record(conn, cursor, statement, *args):
        if 'count(' in statement.lower() and 'provider_bars' in statement:
            statements.append(statement)

    event.listen(engine, 'before_cursor_execute', record)
    try:
        provider_service.cleanup()
        provider_service.cleanup()
    finally:
        event.remove(engine, 'before_cursor_execute', record)
    assert statements == []


def test_indicator_idle_retains_fast_cadence_for_active_rules(database, monkeypatch):
    from alerts import alert_indicator_worker, publication_wakeup, runtime_health
    from alerts.storage import ChartAlert

    monkeypatch.setattr(publication_wakeup, 'PublicationWakeup', lambda **kw: Wake())
    monkeypatch.setattr(runtime_health, 'progress', lambda **kw: None)
    stop = Stop(2)
    alert_indicator_worker.run(stop)
    assert stop.delays == [1, 1]
    with database.begin() as db:
        db.add(ChartAlert(request_id='idle-test', request_hash='test', name='Idle test', effective_at=1))
    stop = Stop(2)
    alert_indicator_worker.run(stop)
    assert stop.delays == [.1, .1]


def test_stream_future_work_keeps_fast_cadence_and_empty_queue_sleeps(database, monkeypatch):
    from alerts import market_stream_worker as worker
    from alerts import publication_wakeup, runtime_health

    monkeypatch.setattr(publication_wakeup, 'PublicationWakeup', lambda **kw: Wake())
    monkeypatch.setattr(runtime_health, 'progress', lambda **kw: None)
    monkeypatch.setattr(worker.stream, 'cleanup', lambda: None)
    active = iter([False, True, False])

    def claim(**kwargs):
        kwargs['activity']['active'] = next(active)

    monkeypatch.setattr(worker.stream, 'claim', claim)
    stop = Stop(3)
    worker.run(stop)
    assert stop.delays == [1, .1, 1]


def test_capacity_scan_is_separate_from_minute_expiry_and_retries_failure(monkeypatch):
    from alerts import runtime_health

    clock, checks = [0], []
    monkeypatch.setattr(provider_service.time, 'monotonic', lambda: clock[0])
    monkeypatch.setattr(runtime_health, 'progress', lambda **kw: None)
    stop = Stop(7)

    def cleanup(**kwargs):
        checks.append(kwargs['check_capacity'])
        # A failed first capacity round must retry next minute, not wait 5min.
        if len(checks) == 1:
            raise ValueError('fixture failure')

    def wait(seconds):
        stop.delays.append(seconds)
        clock[0] += seconds

    stop.wait = wait
    monkeypatch.setattr(provider_service, 'cleanup', cleanup)
    provider_service.run_janitor(stop)
    assert stop.delays == [60] * 7
    assert checks == [True, True, False, False, False, False, True]
