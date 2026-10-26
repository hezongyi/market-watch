"""Native capability discovery and bounded local catalog lookup regressions."""
import pytest
from alerts import fxcm_history, history_catalog, market_data, provider_fxcm
from alerts.storage import MarketCatalog
from test_fxcm_history import fxcm_config as _fxcm_config

fxcm_config = _fxcm_config

EXPECTED = {'M1':'m1','M5':'m5','M15':'m15','M30':'m30','H1':'H1','H4':'H4','D1':'D1','W1':'W1','MN':'M1'}


def test_system_frames_preserve_forexconnect_month_case():
    assert fxcm_history.FRAMES == EXPECTED


def test_filtered_search_only_reads_selected_local_source(database, fxcm_config, monkeypatch):
    from alerts import akshare_catalog, platform_catalog, yahoo_catalog
    monkeypatch.setattr(yahoo_catalog, 'seed', lambda: pytest.fail('search seeded Yahoo'))
    monkeypatch.setattr(akshare_catalog, 'seed', lambda: pytest.fail('search seeded AKShare'))
    monkeypatch.setattr(yahoo_catalog, 'search', lambda _: pytest.fail('FXCM search queried Yahoo'))
    scope = fxcm_history.account_scope()
    with database.begin() as db:
        for i in range(517):
            db.add(MarketCatalog(id=f'FXCM:{i}', source='fxcm', symbol=f'TEST{i}',
                label=f'TEST{i}', asset_type='CURRENCY', precision=5, available=True,
                metadata_json={'history_account_scope':scope}))
    calls = []
    monkeypatch.setattr(fxcm_history, 'account_scope', lambda: calls.append('scope') or scope)
    rows = market_data.search_series_page('', kind='provider', source='fxcm', page_size=50)
    assert rows['total'] == 517 and len(rows['items']) == 50
    assert calls == ['scope']
    with database() as db:
        assert platform_catalog.catalog(db, source='fxcm', page=6, page_size=100)['total'] == 517


def test_explicit_refresh_persists_supported_intersection(database, fxcm_config, monkeypatch):
    monkeypatch.setattr(fxcm_history.FxcmHistory, 'catalog', lambda _: [
        {'symbol':'EUR/USD','digits':5,'instrument_type':1}])
    monkeypatch.setattr(fxcm_history.FxcmHistory, 'timeframes', lambda _: {'M1':300,'H4':300,'MN':300})
    history_catalog.refresh_fxcm()
    from sqlalchemy import select
    with database() as db:
        row = db.scalar(select(MarketCatalog).where(MarketCatalog.source=='fxcm'))
        ident = row.id
        assert row.metadata_json['native_frames'] == ['M1','H4','MN']
    monkeypatch.setattr(fxcm_history.FxcmHistory, 'timeframes', lambda _: pytest.fail('metadata broker IO'))
    meta = provider_fxcm.metadata(ident)
    assert meta['frames'] == ['M1','H4','MN']
    with pytest.raises(ValueError):
        provider_fxcm.native_page(meta,'M5',100000,1)


@pytest.mark.parametrize('symbol', ['EUR/USD', 'XAU/USD'])
@pytest.mark.parametrize('frame', list(EXPECTED))
def test_recorded_session_native_bars_keep_source_starts(monkeypatch, symbol, frame):
    import json
    from pathlib import Path
    sample_path = Path(__file__).resolve().parents[2] / 'docs/verification/fxcm/mwa-native-periods-20261025/native-session-samples.json'
    sample = next(row for row in json.loads(sample_path.read_text())['samples']
                  if (row['symbol'], row['frame']) == (symbol, frame))
    adapter = fxcm_history.FxcmHistory(clock=lambda: 1800000000000)
    commands = []
    monkeypatch.setattr(adapter, '_request', lambda command, **kwargs: commands.append(command) or sample['bars'])
    bars = adapter.bars(symbol, frame, 0, 1800000000000, 5 if symbol == 'EUR/USD' else 2, count=20)
    assert len(bars) == (19 if frame == 'MN' else 20)
    assert commands[0].splitlines()[2] == EXPECTED[frame]
    from datetime import datetime
    assert [bar['start'] for bar in bars] == sorted({int(datetime.fromisoformat(bar['time'].replace('Z', '+00:00')).timestamp() * 1000) for bar in sample['bars']})
    if frame == 'MN':
        joined = next(bar for bar in bars if 'native_fragments' in bar)
        first, last = joined['native_fragments']
        assert first['close'] == last['open']
        assert joined['open'] == first['open'] and joined['close'] == last['close']
        assert int(joined['volume']) == int(first['volume']) + int(last['volume'])


def test_session_unsupported_frames_are_omitted(monkeypatch):
    adapter = fxcm_history.FxcmHistory()
    monkeypatch.setattr(adapter, '_request', lambda *a, **k: [
        {'id':'m1','query_depth':300}, {'id':'H4','query_depth':-1},
        {'id':'M1','query_depth':300}, {'id':'H6','query_depth':300}])
    assert adapter.timeframes() == {'M1':300, 'MN':300}


def test_month_page_drops_potentially_truncated_oldest_native_month(monkeypatch):
    adapter = fxcm_history.FxcmHistory(clock=lambda: 1800000000000)
    raw = [{'kind':'candle','time':time,'open':'1.1','high':'1.2','low':'1','close':'1.1','volume':1}
           for time in ['2026-06-30T21:00:00Z','2026-07-31T21:00:00Z','2026-08-31T21:00:00Z']]
    monkeypatch.setattr(adapter,'_request',lambda *a, **k: raw)
    bars=adapter.bars('EUR/USD','MN',0,1800000000000,5,count=1)
    assert len(bars)==1 and bars[0]['start']==1788210000000


def test_month_conflicting_or_ambiguous_fragments_fail_explicitly():
    base={'start':0,'open':'1','high':'3','low':'1','close':'2','volume':'1'}
    with pytest.raises(ValueError,match='无法唯一拼接'):
        fxcm_history.assemble_native_months([base,base])


def test_known_fxcm_code_in_all_search_never_expands_yahoo(database, fxcm_config, monkeypatch):
    from alerts import yahoo_catalog
    from alerts.config import settings
    monkeypatch.setattr(settings, 'yahoo_enabled', True)
    with database.begin() as db:
        db.add(MarketCatalog(id='FXCM:local-dollar',source='fxcm',symbol='USDOLLAR',label='USDOLLAR',
            asset_type='INDEX',precision=0,available=True,
            metadata_json={'history_account_scope':fxcm_history.account_scope()}))
    monkeypatch.setattr(yahoo_catalog, 'search', lambda _: pytest.fail('Known FXCM code triggered remote search'))
    assert market_data.search_series_page('USDOLLAR',kind='all')['items'][0]['source']=='fxcm'


def test_fxcm_snapshot_freshness_matches_its_finite_poll_interval():
    from alerts.provider_capabilities import fresh_seconds, poll_seconds
    assert fresh_seconds('fxcm') == poll_seconds('fxcm') >= 60
