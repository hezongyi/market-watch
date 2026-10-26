"""Reserve reads keep persisted Yahoo metadata available even when it expires."""

import pytest
from alerts import provider_cache as cache
from alerts import provider_chart as upstream
from alerts import provider_yahoo as yahoo
from alerts import storage, yahoo_catalog
from alerts.chart_query import DataQuery
from alerts.config import settings
from alerts.query_errors import QueryError
from test_provider_cache import page, seed


@pytest.mark.parametrize('expired', [False, True])
@pytest.mark.parametrize('cached', [False, True])
def test_yahoo_reserve_never_refreshes_metadata(database, monkeypatch, expired, cached):
    monkeypatch.setattr(settings, 'yahoo_enabled', True)
    details = yahoo._metadata({'symbol': 'CL=F', 'quoteType': 'FUTURE', 'exchange': 'NYM',
                              'exchangeTimezoneName': 'America/New_York'})
    ident = yahoo_catalog._store(details)
    meta = upstream.metadata(ident)
    if cached:
        seed(meta, 'M5', 1000000, page(900000, 1000000))
    with database.begin() as db:
        if expired:
            db.get(storage.MarketCatalog, ident).updated_at = 0
    def no_provider(*args, **kwargs):
        pytest.fail('PG-only reserve called the provider')
    monkeypatch.setattr(yahoo, 'metadata', no_provider)
    monkeypatch.setattr(upstream, 'native_page', no_provider)
    body = DataQuery(instrument=ident, series_kind='provider', timeframe='M5',
                     before=1000000, countBack=50, limit=50, client='reserve-yahoo',
                     native_history={'chart_count': 4, 'focused': False},
                     native_reserve={'screen_bars': 50, 'batch_screens': 1})
    result = cache.data(body)
    assert result['reserve_status'] == ('ready' if cached else 'miss')
    assert len(result['bars']) == (50 if cached else 0)
    assert result['mandatory_count'] == 0 and result['candles_http_attempts'] == []
    assert not result['history_boundary']


def test_yahoo_mandatory_read_still_refreshes_expired_metadata(database, monkeypatch):
    monkeypatch.setattr(settings, 'yahoo_enabled', True)
    details = yahoo._metadata({'symbol': 'CL=F', 'quoteType': 'FUTURE', 'exchange': 'NYM',
                              'exchangeTimezoneName': 'America/New_York'})
    ident = yahoo_catalog._store(details)
    with database.begin() as db:
        db.get(storage.MarketCatalog, ident).updated_at = 0
    refreshed = []
    monkeypatch.setattr(yahoo, 'metadata', lambda *args, **kwargs: refreshed.append(args) or details)
    assert upstream.metadata(ident)['symbol'] == 'CL=F'
    assert len(refreshed) == 1


@pytest.mark.parametrize('details', [{}, {'symbol': 'CL=F', 'asset_type': 'FUTURE'}])
def test_unresolved_yahoo_reserve_fails_without_provider_io(database, monkeypatch, details):
    monkeypatch.setattr(settings, 'yahoo_enabled', True)
    ident = yahoo.stable_id('CL=F')
    with database.begin() as db:
        db.add(storage.MarketCatalog(id=ident, source='yahoo', symbol='CL=F', label='Crude oil', asset_type='FUTURE',
                                     precision=8, calendar='yahoo', available=True,
                                     metadata_json=details, updated_at=0))
    monkeypatch.setattr(yahoo, 'metadata', lambda *a, **k: pytest.fail('reserve refreshed metadata'))
    with pytest.raises(QueryError) as error:
        cache.data(DataQuery(instrument=ident, series_kind='provider', timeframe='M5',
                            before=1000000, native_history={'chart_count': 1},
                            native_reserve={'screen_bars': 50, 'batch_screens': 1}))
    assert error.value.status_code == 503
