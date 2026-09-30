from alerts.chart_aggregation import aggregate_once, enqueue_aggregation
from alerts.storage import ChartAggregationJob, ChartViewportDemand, Instrument
from sqlalchemy import func, select


def test_queue_is_durable_deduplicated_and_selected_period_first(database, monkeypatch):
    from alerts import market, storage

    now = 1790780000000
    monkeypatch.setattr(storage, 'now_ms', lambda: now)
    with database.begin() as db:
        enqueue_aggregation(db, 'EURUSD', now-600000, now, now)
        enqueue_aggregation(db, 'EURUSD', now-600000, now, now)
        assert db.scalar(select(func.count()).select_from(ChartAggregationJob)) == 5
        db.add(ChartViewportDemand(id='pane', instrument_id='EURUSD', timeframe='D1',
                                  start=now-600000, end=now, warm_start=now-1200000,
                                  focused=True, expires=now+45000))
    calls = []
    monkeypatch.setattr(market, 'aggregate_touched', lambda *args, **kwargs:
                        calls.append(kwargs['timeframes'][0]))
    assert aggregate_once()
    assert calls == ['D1']
    with database.begin() as db:
        db.get(ChartViewportDemand, 'pane').timeframe = 'M30'
    assert aggregate_once()
    assert calls == ['D1', 'M15']
    with database.begin() as db:
        assert db.scalar(select(func.count()).select_from(ChartAggregationJob)) == 3
        assert db.get(Instrument, 'EURUSD')


def test_failed_aggregation_keeps_task_for_restart(database, monkeypatch):
    from alerts import market

    with database.begin() as db:
        enqueue_aggregation(db, 'EURUSD', 60000, 120000, 120000)
    def fail(*args, **kwargs):
        raise RuntimeError('interrupted')
    monkeypatch.setattr(market, 'aggregate_touched', fail)
    assert aggregate_once()
    with database.begin() as db:
        assert db.scalar(select(func.count()).select_from(ChartAggregationJob)) == 5

    with database.begin() as db:
        failed = db.scalar(select(ChartAggregationJob).where(ChartAggregationJob.attempts > 0))
        assert failed.error == 'RuntimeError' and failed.next_at > 0
        failed_id = failed.id
    calls = []
    monkeypatch.setattr(market, 'aggregate_touched', lambda *args, **kwargs:
                        calls.append(kwargs['timeframes'][0]))
    assert aggregate_once()
    assert len(calls) == 1
    with database.begin() as db:
        assert db.get(ChartAggregationJob, failed_id) is not None
        assert db.scalar(select(func.count()).select_from(ChartAggregationJob)) == 4


def test_failed_calculation_rolls_back_partial_bars(database, monkeypatch):
    from alerts import market
    from alerts.storage import Bar

    with database.begin() as db:
        enqueue_aggregation(db, 'EURUSD', 60000, 120000, 120000)
    def partial_write(db, inst, touched, **kwargs):
        db.add(Bar(instrument_id=inst.id, timeframe=kwargs['timeframes'][0],
                   start=0, end=300000, open=1, high=1, low=1, close=1, complete=True))
        db.flush()
        raise ValueError('failed after partial write')
    monkeypatch.setattr(market, 'aggregate_touched', partial_write)
    assert aggregate_once()
    with database.begin() as db:
        assert db.scalar(select(func.count()).select_from(Bar)) == 0
        assert db.scalar(select(func.count()).select_from(ChartAggregationJob)) == 5
        assert db.scalar(select(ChartAggregationJob.error).where(
            ChartAggregationJob.attempts == 1)) == 'ValueError'


def test_deferred_ingestion_hides_old_bars_until_rebuilt(database, monkeypatch):
    from datetime import UTC, datetime

    from alerts import market, market_data, storage
    from alerts.chart_data import chart_rows
    from alerts.storage import Bar, ms

    start = ms(datetime(2026, 9, 21, tzinfo=UTC))
    now = start+10*60000+5000
    monkeypatch.setattr(storage, 'now_ms', lambda: now)
    monkeypatch.setattr(market_data, 'now_ms', lambda: now)
    payload = {'source': 'oanda', 'basis': 'mid',
               'rows': [dict(timestamp=start+i*60000, open=10, high=11, low=9, close=10)
                        for i in range(10)],
               'coverage': [{'start': start, 'end': start+10*60000}]}
    with database.begin() as db:
        inst = db.get(Instrument, 'EURUSD')
        inst.source, inst.basis = 'oanda', 'mid'
        market.ingest(db, inst, payload, received_at=now)
    payload['rows'][0]['high'] = 15
    with database.begin() as db:
        inst = db.get(Instrument, 'EURUSD')
        market.ingest(db, inst, payload, received_at=now, defer_aggregation=True)
        assert db.scalar(select(func.count()).select_from(ChartAggregationJob)) == 5
        assert not db.scalar(select(Bar.complete).where(Bar.timeframe == 'M5').limit(1))
        assert chart_rows(db, inst, 'M5', now, 20, now)[0]['pending_aggregation']
    # Coverage exists, but neither a stale closed bar nor a forming H1 is usable.
    for frame in ('M5', 'H1'):
        assert market_data.read_cached_history(market_data.HistoryQuery(
            instrument='EURUSD', timeframe=frame))['bars'] == []
    for _ in range(5):
        assert aggregate_once()
    assert not aggregate_once()
    page = market_data.read_cached_history(market_data.HistoryQuery(
        instrument='EURUSD', timeframe='M5'))
    assert len(page['bars']) == 2
    assert float(page['bars'][0]['high']) == 15
    assert all(row['complete'] for row in page['bars'])


def test_download_backpressure_skips_provider_when_aggregation_is_full(database):
    from alerts.market import import_once
    from alerts.storage import ImportJob

    with database.begin() as db:
        for index in range(12):
            enqueue_aggregation(db, 'EURUSD', index*60000, (index+1)*60000, 0)
        db.add(ImportJob(instrument_id='EURUSD', start=0, end=60000, cursor=0,
                         priority=100, next_at=0))
    def forbidden(*args, **kwargs):
        raise AssertionError('download must wait for aggregation capacity')
    assert not import_once(chart_only=True, defer_aggregation=True, fetcher=forbidden)
    with database.begin() as db:
        job = db.scalar(select(ImportJob))
        assert job.status == 'pending' and job.cursor == 0


def test_failed_symbol_backlog_does_not_block_other_symbol(database):
    from alerts.market import import_once
    from alerts.storage import ImportJob

    with database.begin() as db:
        for index in range(12):
            enqueue_aggregation(db, 'EURUSD', index*60000, (index+1)*60000, 0)
        for task in db.scalars(select(ChartAggregationJob)):
            task.error = 'RuntimeError'
            task.attempts = 1
        db.add_all([
            ImportJob(instrument_id='EURUSD', start=0, end=60000, cursor=0,
                      priority=100, next_at=0),
            ImportJob(instrument_id='XAUUSD', start=0, end=60000, cursor=0,
                      priority=110, next_at=0),
        ])
    calls = []
    def fetch(source, symbol, start, end):
        calls.append(symbol)
        # Selection is what this regression exercises; retain normal retry state.
        raise RuntimeError('provider unavailable')
    assert import_once(chart_only=True, defer_aggregation=True, fetcher=fetch)
    with database.begin() as db:
        assert calls == [db.get(Instrument, 'XAUUSD').symbol]
        blocked = db.scalar(select(ImportJob).where(ImportJob.instrument_id == 'EURUSD'))
        selected = db.scalar(select(ImportJob).where(ImportJob.instrument_id == 'XAUUSD'))
        assert blocked.status == 'pending' and blocked.attempts == 0
        assert selected.attempts == 1
        assert db.scalar(select(func.count()).select_from(ChartAggregationJob)) == 60
