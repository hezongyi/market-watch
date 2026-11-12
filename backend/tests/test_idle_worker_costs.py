"""Idle scans stay bounded; committed demand and real content retain fast paths."""
from types import SimpleNamespace

import pytest
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


def test_incomplete_day_fallback_reuses_boundaries_without_skipping_full_calculation(database, monkeypatch):
    from alerts import market

    with database.begin() as db:
        # No retained complete aggregate: this must execute the full fallback,
        # including coverage/completeness checks and the ordinary bar writer.
        db.execute(Bar.__table__.insert(), [dict(instrument_id='BTCUSDT', timeframe='M1',
            start=i*60000, end=(i+1)*60000, open=10, high=12, low=9, close=11,
            complete=False, observed_at=86401000) for i in range(1440)])
    calls = []
    original = market.bucket_bounds

    def bounds(*args):
        calls.append(args)
        return original(*args)

    monkeypatch.setattr(market, 'bucket_bounds', bounds)
    with database.begin() as db:
        assert market.aggregate_touched(db, db.get(Instrument, 'BTCUSDT'),
            {instant(i*60000) for i in range(120)}, received_at=86401000,
            timeframes=('D1',), kind='observed')
        day = db.scalar(select(Bar).where(Bar.instrument_id == 'BTCUSDT', Bar.timeframe == 'D1'))
        assert not day.complete and (day.open, day.high, day.low, day.close) == (10, 12, 9, 11)
    assert len(calls) <= 5


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
    assert stop.delays == [5, .1, 5]


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


@pytest.mark.parametrize('frame,seconds,derived', [('M15', 900, {'M30'}), ('D1', 86400, {'W1', 'MN'})])
def test_atomic_native_observation_only_schedules_derived_and_keeps_content_repair(database, frame, seconds, derived):
    from decimal import Decimal

    from alerts.bar_batch import write_bars
    from alerts.domain import Candle
    from alerts.storage import (
        ChartPublication,
        ChartPublicationJob,
        ChartPublicationState,
        ChartPublishedBar,
        candle_dict,
    )

    candle = Candle(instant(0), instant(seconds*1000), *[Decimal(10)]*4)
    with database.begin() as db:
        write_bars(db, 'BTCUSDT', frame, [candle], observed_at=100)
        bar = db.scalar(select(Bar).where(Bar.instrument_id == 'BTCUSDT', Bar.timeframe == frame))
        payload = {**candle_dict(bar.candle()), 'observed_at': 100, 'confirmed_at': bar.received_at}
        db.add(ChartPublishedBar(instrument_id='BTCUSDT', timeframe=frame, start=0,
            end=seconds*1000, complete=True, payload=payload, revision=1))
        for target in {frame, *derived}:
            db.add(ChartPublication(instrument_id='BTCUSDT', timeframe=target,
                start=-40*86400000, end=40*86400000, initialized=True))
            db.add(ChartPublicationState(instrument_id='BTCUSDT', timeframe=target, requested=1, processed=1))
    with database.begin() as db:
        write_bars(db, 'BTCUSDT', frame, [candle], observed_at=200)
        assert set(db.scalars(select(ChartPublicationJob.timeframe))) == derived
        native = db.get(ChartPublicationState, ('BTCUSDT', frame))
        assert native.requested == native.processed == 1
        snapshot = db.get(ChartPublishedBar, ('BTCUSDT', frame, 0))
        assert snapshot.payload['observed_at'] == 200 and snapshot.revision == 1
        snapshot.payload = {**snapshot.payload, 'high': '99'}
    with database.begin() as db:
        write_bars(db, 'BTCUSDT', frame, [candle], observed_at=300)
        assert set(db.scalars(select(ChartPublicationJob.timeframe))) == derived | {frame}
        native = db.get(ChartPublicationState, ('BTCUSDT', frame))
        assert native.requested > native.processed


def test_stream_error_keeps_existing_retry_instead_of_idle_backoff(database, monkeypatch):
    from alerts import market_stream_worker as worker
    from alerts import publication_wakeup, runtime_health

    monkeypatch.setattr(publication_wakeup, 'PublicationWakeup', lambda **kw: Wake())
    monkeypatch.setattr(runtime_health, 'progress', lambda **kw: None)
    monkeypatch.setattr(worker.stream, 'cleanup', lambda: None)
    attempts = []
    def claim(**kwargs):
        attempts.append(1)
        if len(attempts) == 1:
            raise OSError('transient query failure')
        kwargs['activity']['active'] = False
    monkeypatch.setattr(worker.stream, 'claim', claim)
    stop = Stop(2)
    worker.run(stop)
    assert stop.delays == [1, 5]
