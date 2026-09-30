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
    import pytest
    from alerts import market

    with database.begin() as db:
        enqueue_aggregation(db, 'EURUSD', 60000, 120000, 120000)
    def fail(*args, **kwargs):
        raise RuntimeError('interrupted')
    monkeypatch.setattr(market, 'aggregate_touched', fail)
    with pytest.raises(RuntimeError, match='interrupted'):
        aggregate_once()
    with database.begin() as db:
        assert db.scalar(select(func.count()).select_from(ChartAggregationJob)) == 5
