from datetime import UTC, datetime, timedelta
from decimal import Decimal

from alerts import market_data
from alerts.bar_batch import write_bars
from alerts.domain import Candle
from alerts.storage import ImportJob, Instrument, ms
from sqlalchemy import func, select


def test_cache_read_never_plans_and_filters_historical_partial(database, monkeypatch):
    start = datetime(2026, 9, 21, tzinfo=UTC)
    price = Decimal('1.2')
    with database.begin() as db:
        db.get(Instrument, 'EURUSD').source = 'oanda'
        write_bars(db, 'EURUSD', 'H1', [
            Candle(start, start + timedelta(hours=1), price, price, price, price, True),
            Candle(start + timedelta(hours=1), start + timedelta(hours=2),
                   price, price, price, price, False),
        ])
    def forbidden(*args, **kwargs):
        raise AssertionError('cache read entered planner')
    monkeypatch.setattr(market_data, 'queue_history', forbidden)
    monkeypatch.setattr(market_data, 'now_ms', lambda: ms(start + timedelta(days=1)))
    page = market_data.read_cached_history(market_data.HistoryQuery(
        instrument='EURUSD', timeframe='H1', limit=10))
    assert [b['start'] for b in page['bars']] == [ms(start)]
    assert page['remote_boundary'] == 'unknown'
    with database.begin() as db:
        assert db.scalar(select(func.count()).select_from(ImportJob)) == 0


def test_cold_cache_does_not_register_symbol(database):
    page = market_data.read_cached_history(market_data.HistoryQuery(
        instrument='UNSEEN', timeframe='D1'))
    assert page['bars'] == [] and page['next_cursor'] is None
    with database.begin() as db:
        assert db.get(Instrument, 'UNSEEN') is None


def test_forming_bar_requires_covered_prefix(database, monkeypatch):
    start = datetime(2026, 9, 21, tzinfo=UTC)
    price = Decimal('1.2')
    with database.begin() as db:
        db.get(Instrument, 'EURUSD').source = 'oanda'
        write_bars(db, 'EURUSD', 'H1', [Candle(
            start, start + timedelta(hours=1), price, price, price, price, False)])
        write_bars(db, 'EURUSD', 'M1', [Candle(
            start+timedelta(minutes=30), start+timedelta(minutes=31),
            price, price, price, price, True)])
    now = ms(start + timedelta(minutes=31, seconds=5))
    monkeypatch.setattr(market_data, 'now_ms', lambda: now)
    spans = []
    monkeypatch.setattr(market_data, 'stored_coverage', lambda *args: spans)
    query = market_data.HistoryQuery(instrument='EURUSD', timeframe='H1')
    assert market_data.read_cached_history(query)['bars'] == []
    spans.append({'start': ms(start), 'end': now - 5000})
    page = market_data.read_cached_history(query)
    assert len(page['bars']) == 1 and not page['bars'][0]['complete']
    # Provider has not delivered another minute yet; time passing must not make
    # the last valid forming snapshot disappear and reset the chart repeatedly.
    monkeypatch.setattr(market_data, 'now_ms', lambda: now+120000)
    assert len(market_data.read_cached_history(query)['bars']) == 1
    spans.clear()
    spans.append({'start': ms(start+timedelta(minutes=1)), 'end': now-5000})
    assert market_data.read_cached_history(query)['bars'] == []


def test_cache_endpoint_uses_existing_authentication(database):
    from alerts import api as api_module
    from fastapi.testclient import TestClient

    body = {'instrument': 'UNSEEN', 'timeframe': 'D1'}
    with TestClient(api_module.app) as client:
        assert client.post('/api/market-data/history/cache', json=body).status_code in (401, 403)
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: 'test'
    try:
        with TestClient(api_module.app) as client:
            response = client.post('/api/market-data/history/cache', json=body)
            assert response.status_code == 200
            assert response.json()['bars'] == []
    finally:
        api_module.app.dependency_overrides.clear()


def test_cache_does_not_bridge_unqueried_trading_gap(database, monkeypatch):
    start = datetime(2026, 9, 21, tzinfo=UTC)
    price = Decimal('1.2')
    with database.begin() as db:
        db.get(Instrument, 'EURUSD').source = 'oanda'
        write_bars(db, 'EURUSD', 'H1', [Candle(
            start+timedelta(hours=i), start+timedelta(hours=i+1),
            price, price, price, price, True) for i in (0, 2, 3)])
    monkeypatch.setattr(market_data, 'now_ms', lambda: ms(start+timedelta(days=1)))
    page = market_data.read_cached_history(market_data.HistoryQuery(
        instrument='EURUSD', timeframe='H1'))
    assert [b['start'] for b in page['bars']] == [ms(start+timedelta(hours=i)) for i in (2,3)]
