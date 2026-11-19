"""Historical throughput must not change live budgets or aggregate contents."""
from collections import Counter
from datetime import UTC, datetime, timedelta

import pytest
from alerts import chart_aggregation as aggregation
from alerts import chart_aggregation_worker as worker
from alerts import market, publication_budget, storage
from sqlalchemy import func, select

MINUTE = 60000
DAY = 1440 * MINUTE
START = storage.ms(datetime(2026, 10, 28, tzinfo=UTC))


def queue_week(database, monkeypatch):
    now = START + 30 * DAY
    monkeypatch.setattr(storage, 'now_ms', lambda: now)
    with database.begin() as db:
        aggregation.enqueue_aggregation(db, 'BTCUSDT', START, START + 9 * DAY, now - 20000)
        for kind, frame in (('observed', 'M5'), ('volume', 'M15'), ('price', 'H1')):
            db.add(storage.ChartAggregationJob(id=kind, instrument_id='BTCUSDT',
                timeframe=frame, kind=kind, start=START+MINUTE, end=START+2*MINUTE,
                created_at=now-10000, attempts=int(kind == 'price')))
        db.add(storage.ChartAggregationJob(id='recent', instrument_id='BTCUSDT',
            timeframe='M5', start=now-MINUTE, end=now, created_at=now))
    monkeypatch.setattr(worker, 'publish_once', lambda: True)
    calls = []
    monkeypatch.setattr(market, 'aggregate_touched', lambda db, inst, touched, **kw:
                        calls.append(kw['touched_by_frame']))
    return calls


def test_worker_batches_one_old_week_leaving_live_and_retry_jobs(database, monkeypatch):
    calls = queue_week(database, monkeypatch)
    assert worker.cycle() == (True, True)
    assert set(calls[0]) == set(aggregation.PERIODS)
    assert all(len(touched) == 7 * 1440 for touched in calls[0].values())
    with database.begin() as db:
        for ident in ('observed', 'volume', 'price', 'recent'):
            assert db.get(storage.ChartAggregationJob, ident) is not None
        remaining = list(db.scalars(select(storage.ChartAggregationJob).where(
            storage.ChartAggregationJob.id.not_in(('observed', 'volume', 'price', 'recent')))))
        assert len(remaining) == 10
        assert min(row.start for row in remaining) == START + 7 * DAY


def test_explicit_shared_budget_stays_small_even_inside_worker(database, monkeypatch):
    calls = queue_week(database, monkeypatch)
    with publication_budget.work_budget() as budget:
        worker.cycle()
        assert budget.rows == 4096  # mocked rebuild consumes no rows
    assert all(len(touched) == 2 * 1440 for touched in calls[0].values())


@pytest.mark.parametrize('kind,attempts,recent', [
    ('price', 0, True), ('observed', 0, False), ('volume', 0, False), ('price', 1, False)])
def test_worker_keeps_small_slices_outside_old_price(database, monkeypatch, kind, attempts, recent):
    now = START + (1 if recent else 30) * DAY + 5000
    monkeypatch.setattr(storage, 'now_ms', lambda: now)
    with database.begin() as db:
        db.add(storage.ChartAggregationJob(instrument_id='BTCUSDT', timeframe='M5',
            kind=kind, start=START, end=START+DAY, created_at=now-20000, attempts=attempts))
    calls = []
    def rebuild(db, inst, touched, **kw):
        calls.append((len(touched), publication_budget.current().rows))
    monkeypatch.setattr(market, 'aggregate_touched', rebuild)
    monkeypatch.setattr(worker, 'publish_once', lambda: True)
    worker.cycle()
    assert calls == [(120, 4096)]


def test_rebuild_reuses_minute_checks_only_within_current_batch(database, monkeypatch):
    """Uncovered sparse inputs exercise the calendar path in every timeframe."""
    first = datetime(2026, 10, 28, tzinfo=UTC)
    now = START + 2 * DAY
    with database.begin() as db:
        db.add_all([storage.Bar(instrument_id='BTCUSDT', timeframe='M1',
            start=START+i*MINUTE, end=START+(i+1)*MINUTE,
            open=10, high=11, low=9, close=10, complete=True)
            for i in range(30)])
    conversions, checks = Counter(), Counter()
    original_instant, original_open = market.instant, market.scheduled_open
    def instant(at):
        conversions[at] += 1
        return original_instant(at)
    def opened(at, *args, **kwargs):
        checks[at] += 1
        return original_open(at, *args, **kwargs)
    monkeypatch.setattr(market, 'instant', instant)
    monkeypatch.setattr(market, 'scheduled_open', opened)
    touched = {first + timedelta(minutes=i) for i in range(30)}
    def rebuild():
        with database.begin() as db:
            market.aggregate_touched(db, db.get(storage.Instrument, 'BTCUSDT'),
                touched, received_at=now)
    rebuild()
    assert max(conversions.values()) == 1
    assert max(checks.values()) == 1
    assert checks[first] == 1
    conversions.clear()
    checks.clear()
    # A correction/new call must compute afresh, not reuse a previous result.
    with database.begin() as db:
        db.scalar(select(storage.Bar).where(storage.Bar.timeframe=='M1',
            storage.Bar.start==START)).high = 20
    rebuild()
    assert checks[first] == 1
    assert max(conversions.values()) == 1
    with database.begin() as db:
        assert db.scalar(select(func.min(storage.Bar.high)).where(
            storage.Bar.timeframe != 'M1', storage.Bar.start == START)) == 20


def test_historical_allowance_is_opt_in_once_and_cannot_revive_expired_work():
    with publication_budget.work_budget(historical_rows=12288) as budget:
        budget.reserve_slice()
        budget.reserve_historical_slice()
        assert budget.rows == 16384
        budget.consume(10080)
        budget.reserve_historical_slice()
        assert budget.rows == 6304
        budget.deadline = -1
        budget.historical_rows = 12288
        budget.reserve_historical_slice()
        assert budget.available == 0 and budget.rows == 6304


@pytest.mark.parametrize('available,days', [(16384, 7), (10000, 6)])
def test_ny17_autumn_dst_batch_respects_complete_buckets_and_row_bound(
        database, monkeypatch, available, days):
    from alerts.domain import calendar_for

    start = storage.ms(datetime(2026, 10, 28, 21, tzinfo=UTC))
    now = start + 30 * DAY
    monkeypatch.setattr(storage, 'now_ms', lambda: now)
    with database.begin() as db:
        aggregation.enqueue_aggregation(db, 'EURUSD', start, start+9*DAY, now-20000)
        inst = db.get(storage.Instrument, 'EURUSD')
        job = db.scalar(select(storage.ChartAggregationJob).where(
            storage.ChartAggregationJob.timeframe == 'D1').order_by(storage.ChartAggregationJob.start))
        plans = aggregation._batch(db, job, calendar_for(inst), now, available)
        left = min(a for _, _, a, _ in plans)
        right = max(b for _, _, _, b in plans)
        assert (right-left)//MINUTE == days*1440+60
        assert (right-left)//MINUTE <= available
        assert len({item.id for item, *_ in plans}) == len(plans) <= 64


def test_failed_week_rebuild_keeps_every_job_and_rolls_back_all_outputs(database, monkeypatch):
    queue_week(database, monkeypatch)
    with database.begin() as db:
        before = set(db.scalars(select(storage.ChartAggregationJob.id)))
    def partial(db, inst, touched, **kw):
        assert len(kw['touched_by_frame']['M5']) == 7*1440
        db.add(storage.Bar(instrument_id=inst.id, timeframe='M5', start=START,
            end=START+5*MINUTE, open=10, high=11, low=9, close=10, complete=True))
        db.flush()
        raise ValueError('interrupted batch')
    monkeypatch.setattr(market, 'aggregate_touched', partial)
    worker.cycle()
    with database.begin() as db:
        assert set(db.scalars(select(storage.ChartAggregationJob.id))) == before
        assert db.scalar(select(func.count()).select_from(storage.Bar)) == 0
        assert db.scalar(select(func.count()).select_from(storage.ChartAggregationJob).where(
            storage.ChartAggregationJob.attempts > 0)) == 2  # one existing retry + selected job
