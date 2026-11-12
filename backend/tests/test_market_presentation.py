"""Display changes must preserve acquisition identities across all series kinds."""
import copy

import pytest
from alerts.market_presentation import present, source_name


@pytest.mark.parametrize(('source', 'family', 'environment', 'expected'), [
    ('akshare', 'sina-a', 'public', '新浪（AKShare）'),
    ('akshare', 'tencent-a', 'public', '腾讯（AKShare）'),
    ('akshare', 'eastmoney-a', 'public', '东方财富（AKShare）'),
    ('akshare', 'sina-futures', 'public', '新浪（AKShare）'),
    ('oanda', None, 'practice', 'OANDA Practice'),
    ('oanda', None, 'live', 'OANDA Live'),
    ('oanda', None, None, 'OANDA'),
    ('fxcm', None, 'demo', 'FXCM Demo'),
    ('fxcm', None, 'real', 'FXCM Real'),
    ('binance', None, 'spot', 'Binance Spot'),
    ('yahoo', None, 'public', 'Yahoo Finance'),
])
def test_source_names_use_upstream_and_actual_environment(source, family, environment, expected):
    assert source_name(source, family=family, environment=environment) == expected


def test_fixed_history_keeps_its_saved_source_and_effective_adjustment():
    identity = {'source': 'akshare', 'source_family': 'tencent-a', 'environment': 'public',
                'provider_symbol': 'SZSE:000001', 'basis': 'last', 'adjustment': 'none'}
    meta = {'source': 'akshare', 'symbol': 'SZ000001', 'name': '用户名称 · 腾讯',
            'display_symbol': 'SZSE:000001', 'series_kind': 'history', 'adjustment_view': 'qfq'}
    original = copy.deepcopy((meta, identity))
    result = present(meta, identity=identity)
    assert result['instrument_name'] == '用户名称 · 腾讯'
    assert result['display_symbol'] == '000001'
    assert result['symbol'] == 'SZ000001'
    assert identity['provider_symbol'] == 'SZSE:000001'
    assert result['source_display'] == '腾讯（AKShare）'
    assert result['price_basis_display'] == '前复权'
    assert result['series_kind_display'] == '自建'
    assert (meta, identity) == original


def test_composite_keeps_both_pinned_sources_even_when_current_account_changes():
    history = {'source': 'dukascopy', 'environment': 'public', 'provider_symbol': 'eurusd', 'basis': 'bid'}
    live = {'source': 'oanda', 'environment': 'live', 'provider_symbol': 'EUR_USD', 'basis': 'bid'}
    result = present({'symbol': 'EURUSD', 'name': '欧元 / 美元', 'source': 'composite',
                      'series_kind': 'composite', 'basis': 'bid'}, identity=history, realtime_identity=live)
    assert result['series_kind_display'] == '组合'
    assert result['source_display'] == '历史：Dukascopy → 实时：OANDA Live'
    assert result['price_basis_display'] == '买价'
    assert result['source'] == 'composite'


def test_real_metadata_search_and_quote_share_fixed_history_display(database, monkeypatch):
    from alerts import series_access
    from alerts.history_api import dataset_report
    from alerts.market_data import QuoteQuery, quote_snapshot
    from alerts.storage import Instrument, MarketDataset
    from test_series_access import fixture
    parent = fixture(database, monkeypatch)
    with database() as db:
        fixed = series_access.metadata(db, parent, 'history')
        combined = series_access.search(db, 'EURUSD', kind='composite')[0]
        dataset = db.get(MarketDataset, fixed['dataset_id'])
        managed = dataset_report(dataset, db.get(Instrument, dataset.instrument_id))
    assert fixed['series_kind_display'] == '自建'
    assert fixed['source_display'] == managed['source_display'] == 'Dukascopy'
    assert combined['source_display'] == '历史：Dukascopy → 实时：OANDA Practice'
    assert combined['source_display'] in combined['description']
    quote = quote_snapshot(QuoteQuery(symbols=['MWH:' + parent]))[0]
    assert quote['v']['description'].startswith(fixed['presentation_description'])
    assert '历史数据时间' in quote['v']['description']


def test_sina_and_tencent_directory_and_resolve_share_names(database, monkeypatch):
    from alerts.akshare_catalog import seed, stable_id
    from alerts.config import settings
    from alerts.history_catalog import catalog as history_catalog
    from alerts.platform_catalog import catalog
    from alerts.provider_chart import metadata
    from alerts.storage import MarketCatalog
    monkeypatch.setattr(settings, 'akshare_enabled', True)
    seed()
    with database.begin() as db:
        row = db.get(MarketCatalog, stable_id('SZSE:000001'))
        row.metadata_json = {**row.metadata_json, 'name_zh': '自定平安银行', 'name_zh_origin': 'manual'}
    with database() as db:
        rows = catalog(db, source='akshare', query='000001')['items']
    assert len(rows) == 4
    for row in rows:
        resolved = metadata(row['id'])
        assert row['label'] == resolved['instrument_name'] == '自定平安银行'
        assert row['display_symbol'] == resolved['display_symbol'] == '000001'
        assert row['provider_symbol'] == resolved['symbol'] == 'SZSE:000001'
        expected_price = '不复权' if row['id'].startswith(('SINA-NATIVE:', 'TENCENT-NATIVE:')) else '前复权'
        assert row['price_basis_display'] == resolved['price_basis_display'] == expected_price
        assert row['source_display'] == resolved['source_display']
        assert resolved['presentation_description'].count(row['source_display']) == 1
    assert len({row['id'] for row in rows}) == 4
    with database() as db:
        creation = history_catalog(db, source='akshare', query='000001')['items']
    assert creation[0]['source_display'] == '新浪（AKShare）'
    assert creation[0]['display_symbol'] == '000001'
    futures = metadata(stable_id('SHFE:RB0'))
    assert futures['display_symbol'] == 'RB0'
    assert futures['symbol'] == 'SHFE:RB0'
    assert futures['presentation_description'] == 'RB0 · 螺纹钢主力连续 · 平台 · 新浪（AKShare） · 原始价格'


def test_managed_manual_instrument_name_is_preserved():
    result = present({'symbol': 'EURUSD', 'name': '我的欧元', 'source': 'dukascopy',
                      'series_kind': 'managed'}, identity={'source': 'dukascopy', 'provider_symbol': 'eurusd'})
    assert result['instrument_name'] == '我的欧元'


@pytest.mark.parametrize('code,expected', [
    ('SZSE:000001', '000001'), ('SSE:000001', '000001'), ('HKEX:00700', '00700'),
    ('SHFE:RB0', 'RB0'), ('SHFE:RB2701', 'RB2701'), ('GC=F', 'GC=F'),
    ('CL=F', 'CL=F'), ('^GSPC', '^GSPC'), ('CUSTOM:CODE', 'CUSTOM:CODE'),
])
def test_only_known_exchange_prefixes_are_hidden(code, expected):
    from alerts.market_names import display_code
    assert display_code(code) == expected
