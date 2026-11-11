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


@pytest.mark.parametrize('damage', ['missing', 'incomplete', 'content'])
def test_observed_input_repairs_unusable_hour_instead_of_losing_task(database, monkeypatch, damage):
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
        hour = db.scalar(select(Bar).where(Bar.instrument_id == inst.id, Bar.timeframe == 'H1'))
        if damage == 'missing':
            db.delete(hour)
        elif damage == 'incomplete':
            hour.complete = False
        else:
            hour.high = 99
    now += 1000
    with database.begin() as db:
        market.ingest(db, db.get(Instrument, 'BTCUSDT'), dict(rows=rows[-1:]), received_at=now)
    for _ in range(40):
        aggregate_once()
        managed.publish_once()
    with database.begin() as db:
        hour = managed.read_rows(db, db.get(Instrument, 'BTCUSDT'), 'H1', now, 1)[0]
        assert hour['complete'] and float(hour['high']) == 11 and hour['observed_at'] == now


def test_rejected_fast_path_reads_dst_source_once_within_reserved_budget(database):
    from decimal import Decimal

    from alerts.bar_batch import write_bars
    from alerts.domain import Candle
    from alerts.publication_budget import work_budget
    from sqlalchemy.orm import Session

    start = ms(datetime.fromisoformat('2026-10-31T21:00:00+00:00'))
    end = ms(datetime.fromisoformat('2026-11-01T22:00:00+00:00'))
    price = Decimal(10)
    candles = [Candle(instant(at), instant(at+60000), price, price, price, price)
               for at in range(start, end, 60000)]
    with database.begin() as db:
        inst = db.get(Instrument, 'BTCUSDT')
        inst.calendar = 'ny17'
        db.add(storage.MarketCoverage(instrument_id=inst.id, source=inst.source, basis=inst.basis,
                                      start=start, end=end))
        write_bars(db, inst.id, 'M1', candles, observed_at=end+5000)
        market.aggregate_touched(db, inst, {instant(start)}, received_at=end+5000, timeframes=('D1',))
        day = db.scalar(select(Bar).where(Bar.timeframe == 'D1'))
        assert day.complete
        day.high = 99  # Retained stale content, without a live price-repair job.
    returned = []
    def observe(query):
        result = query.invoke_statement()
        if query.is_select and 'FROM candles' in str(query.statement) and 'M1' in query.statement.compile().params.values():
            snapshot = result.freeze()
            returned.append(len(snapshot.data))
            return snapshot()
        return result
    event.listen(Session, 'do_orm_execute', observe, retval=True)
    try:
        with work_budget() as budget, database.begin() as db:
            budget.rows = 1500
            budget.reserve_slice()
            market.aggregate_touched(db, db.get(Instrument, 'BTCUSDT'), {instant(start)},
                                     received_at=end+6000, timeframes=('D1',), kind='observed')
            assert budget.rows == 0
            assert db.scalar(select(Bar.high).where(Bar.timeframe == 'D1')) == price
    finally:
        event.remove(Session, 'do_orm_execute', observe)
    assert sum(returned) == 1500


def test_obsolete_observation_job_does_not_wake_clean_publication(database, monkeypatch):
    from test_publication_scheduler import MINUTE, START

    now = START+60*MINUTE+5000
    monkeypatch.setattr(storage, 'now_ms', lambda: now)
    monkeypatch.setattr(managed, 'now_ms', lambda: now)
    with database.begin() as db:
        inst = db.get(Instrument, 'BTCUSDT')
        managed.join(db, inst, START, now)
        market.ingest(db, inst, dict(rows=[dict(timestamp=START+i*MINUTE,
            open=10, high=11, low=9, close=10) for i in range(60)]), received_at=now)
    for _ in range(40):
        managed.publish_once()
    with database.begin() as db:
        state = db.get(storage.ChartPublicationState, ('BTCUSDT', 'H1'))
        before = state.requested
        db.add(ChartAggregationJob(instrument_id='BTCUSDT', timeframe='H1', kind='observed',
            start=START, end=START+MINUTE, created_at=now))
    assert aggregate_once()
    with database.begin() as db:
        assert db.get(storage.ChartPublicationState, ('BTCUSDT', 'H1')).requested == before


def test_old_overlapping_jobs_and_new_input_keep_partial_slice_remainder(database, monkeypatch):
    from decimal import Decimal

    from alerts.bar_batch import write_bars
    from alerts.domain import Candle
    from test_publication_scheduler import MINUTE, START

    now = START+185*MINUTE+5000
    monkeypatch.setattr(storage, 'now_ms', lambda: now)
    price = Decimal(10)
    rows = [Candle(instant(at), instant(at+MINUTE), price, price, price, price)
            for at in range(START, START+185*MINUTE, MINUTE)]
    with database.begin() as db:
        write_bars(db, 'BTCUSDT', 'M1', rows, observed_at=now)
        for offset in (0, 1):
            db.add(ChartAggregationJob(instrument_id='BTCUSDT', timeframe='H1', kind='observed',
                start=START+offset*MINUTE, end=START+(180+offset)*MINUTE, created_at=now))
    assert aggregate_once()
    with database.begin() as db:
        job = db.scalar(select(ChartAggregationJob))
        assert job.start == START+120*MINUTE and job.end == START+181*MINUTE
    now += 1000
    with database.begin() as db:
        write_bars(db, 'BTCUSDT', 'M1', rows[119:], observed_at=now)
        job = db.scalar(select(ChartAggregationJob).where(ChartAggregationJob.timeframe == 'H1'))
        assert job.start == START+119*MINUTE and job.end == START+185*MINUTE
    for _ in range(20):
        aggregate_once()
    with database.begin() as db:
        hour = db.scalar(select(Bar).where(Bar.timeframe == 'H1', Bar.start == START+120*MINUTE))
        assert hour.complete and hour.observed_at == now
        assert not list(db.scalars(select(ChartAggregationJob)))


@pytest.mark.parametrize('frame', ['W1', 'MN'])
def test_day_observation_refreshes_derived_calendar_snapshot(database, monkeypatch, frame):
    from decimal import Decimal

    from alerts.bar_batch import write_bars
    from alerts.domain import Candle

    day = 86400000
    start = ms(datetime.fromisoformat('2026-01-01T00:00:00+00:00'))
    end, target = start+90*day, start+45*day
    now = end+5000
    monkeypatch.setattr(storage, 'now_ms', lambda: now)
    monkeypatch.setattr(managed, 'now_ms', lambda: now)
    prices = [Decimal(value) for value in ('10', '11', '9', '10')]
    minutes = [Candle(instant(at), instant(at+60000), *prices) for at in (target, target+day-60000)]
    with database.begin() as db:
        inst = db.get(Instrument, 'BTCUSDT')
        managed.join(db, inst, start, now)
        db.add(storage.MarketCoverage(instrument_id=inst.id, source=inst.source, basis=inst.basis,
                                      start=start, end=end))
        db.add_all(Bar(instrument_id=inst.id, timeframe='D1', start=at, end=at+day,
            open=10, high=11, low=9, close=10, complete=True, observed_at=now, received_at=now)
            for at in range(start, end, day))
        write_bars(db, inst.id, 'M1', minutes, observed_at=now)
        db.flush()
    for _ in range(100):
        managed.publish_once()
    with database.begin() as db:
        inst = db.get(Instrument, 'BTCUSDT')
        before = managed.read_rows(db, inst, frame, target+day, 1)[0]
    now += 1000
    with database.begin() as db:
        write_bars(db, 'BTCUSDT', 'M1', minutes, observed_at=now)
    for _ in range(100):
        aggregate_once()
        managed.publish_once()
    with database.begin() as db:
        inst = db.get(Instrument, 'BTCUSDT')
        after = managed.read_rows(db, inst, frame, target+day, 1)[0]
        assert after['observed_at'] == now
        assert {k: v for k, v in after.items() if k != 'observed_at'} == {
            k: v for k, v in before.items() if k != 'observed_at'}
