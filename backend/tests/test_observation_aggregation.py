"""Observed inputs retain source freshness and independent content revisions."""

from datetime import datetime

import pytest
from alerts import managed_dataset as managed
from alerts import market, storage
from alerts.chart_aggregation import aggregate_once, enqueue_aggregation
from alerts.storage import Bar, ChartAggregationJob, Instrument, instant, ms
from sqlalchemy import event, select


@pytest.mark.parametrize(('calendar', 'left', 'right', 'minutes'), [
    ('utc0', '2026-11-01T00:00:00+00:00', '2026-11-02T00:00:00+00:00', 1440),
    ('ny17', '2026-10-31T21:00:00+00:00', '2026-11-01T22:00:00+00:00', 1500),
    ('ny17', '2026-03-07T22:00:00+00:00', '2026-03-08T21:00:00+00:00', 1380),
])
def test_sparse_completed_day_refresh_keeps_calendar_and_revisions(
        database, monkeypatch, calendar, left, right, minutes):
    start, end = ms(datetime.fromisoformat(left)), ms(datetime.fromisoformat(right))
    assert (end-start)//60000 == minutes
    now = end+5000
    monkeypatch.setattr(storage, 'now_ms', lambda: now)
    rows = [dict(timestamp=at, open=10, high=12, low=9, close=11)
            for at in (start, end-60000)]
    with database.begin() as db:
        inst = db.get(Instrument, 'EURUSD')
        inst.source, inst.basis, inst.calendar = 'oanda', 'mid', calendar
        market.ingest(db, inst, dict(source='oanda', basis='mid', rows=rows,
            coverage=[dict(start=start, end=end)]), received_at=now)
        day = db.scalar(select(Bar).where(Bar.instrument_id == inst.id, Bar.timeframe == 'D1',
                                          Bar.start == start))
        assert day.complete and day.end == end
        before = {key: getattr(day, key) for key in (
            'open', 'high', 'low', 'close', 'complete', 'revision', 'received_at',
            'volume', 'volume_complete', 'volume_revision', 'volume_received_at')}
    now += 1000
    with database.begin() as db:
        market.ingest(db, db.get(Instrument, 'EURUSD'), dict(rows=rows), received_at=now)
    observed = now
    now += 10000
    reads = []
    def record(conn, cursor, statement, parameters, context, many):
        if 'FROM audit' in statement or 'FROM market_data_coverage' in statement:
            reads.append(statement)
    engine = database.kw['bind']
    event.listen(engine, 'before_cursor_execute', record)
    try:
        with database.begin() as db:
            market.aggregate_touched(db, db.get(Instrument, 'EURUSD'),
                {instant(start), instant(end-60000)}, received_at=now,
                timeframes=('D1',), kind='observed')
    finally:
        event.remove(engine, 'before_cursor_execute', record)
    with database.begin() as db:
        day = db.scalar(select(Bar).where(Bar.instrument_id == 'EURUSD', Bar.timeframe == 'D1',
                                          Bar.start == start))
        assert day.observed_at == observed
        assert {key: getattr(day, key) for key in before} == before
    assert not reads, 'Verified sparse calendar buckets must not rescan legacy proofs'


def test_observation_merge_keeps_retry_age_and_does_not_upgrade_content_jobs(database):
    with database.begin() as db:
        enqueue_aggregation(db, 'BTCUSDT', 0, 120*60000, 1000, kind='observed')
        for job in db.scalars(select(ChartAggregationJob)):
            job.attempts, job.next_at, job.error = 2, 5000, 'ValueError'
    with database.begin() as db:
        enqueue_aggregation(db, 'BTCUSDT', 60000, 121*60000, 2000, kind='observed')
        enqueue_aggregation(db, 'BTCUSDT', 60*60000, 61*60000, 2000, kind='price')
        jobs = list(db.scalars(select(ChartAggregationJob)))
        assert len(jobs) == 10
        observed = [job for job in jobs if job.kind == 'observed']
        assert len(observed) == 5
        assert all((job.start, job.end, job.created_at, job.attempts, job.next_at, job.error) ==
                   (0, 121*60000, 1000, 2, 5000, 'ValueError') for job in observed)
        assert all(job.end-job.start == 60000 for job in jobs if job.kind == 'price')


def test_observation_waits_for_same_bucket_content_repair_without_losing_request(database, monkeypatch):
    from test_publication_scheduler import MINUTE, START

    now = START+60*MINUTE+5000
    monkeypatch.setattr(storage, 'now_ms', lambda: now)
    monkeypatch.setattr(managed, 'now_ms', lambda: now)
    rows = [dict(timestamp=START+i*MINUTE, open=10, high=11, low=9, close=10)
            for i in range(60)]
    with database.begin() as db:
        inst = db.get(Instrument, 'BTCUSDT')
        managed.join(db, inst, START, now)
        market.ingest(db, inst, dict(rows=rows), received_at=now)
    for _ in range(40):
        managed.publish_once()
    now += 1000
    with database.begin() as db:
        inst = db.get(Instrument, 'BTCUSDT')
        market.ingest(db, inst, dict(rows=[{**rows[0], 'high': 15}]), received_at=now,
                      defer_aggregation=True)
        for job in db.scalars(select(ChartAggregationJob)):
            job.next_at = now+2000
        market.ingest(db, inst, dict(rows=rows[-1:]), received_at=now)
    for _ in range(5):
        assert aggregate_once()
    with database.begin() as db:
        job = db.scalar(select(ChartAggregationJob).where(
            ChartAggregationJob.timeframe == 'H1', ChartAggregationJob.kind == 'observed'))
        assert job is not None and job.attempts == 0 and job.next_at == now+1000
        assert float(managed.read_rows(db, db.get(Instrument, 'BTCUSDT'), 'H1', now, 1)[0]['high']) == 11
    now += 3000
    for _ in range(60):
        aggregate_once()
        managed.publish_once()
        now += 100
    with database.begin() as db:
        hour = managed.read_rows(db, db.get(Instrument, 'BTCUSDT'), 'H1', now, 1)[0]
        assert hour['complete'] and float(hour['high']) == 15
        assert not list(db.scalars(select(ChartAggregationJob)))
