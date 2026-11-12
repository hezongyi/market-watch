"""Native period semantics, persistent identities and legacy compatibility."""

import json
import subprocess
import sys
import time

import pytest
from alerts import akshare_native as native
from alerts import provider_akshare as provider
from alerts.akshare_catalog import details, stable_id
from alerts.config import settings
from alerts.storage import MarketCatalog
from test_native_history_archive import stamp


@pytest.mark.parametrize("family,symbol", [
    ("sina-a", "SSE:600519"), ("tencent-a", "SZSE:000001"), ("tencent-hk", "HKEX:00700")])
def test_routes_request_exact_raw_period_and_keep_month_out_of_minutes(family, symbol):
    meta = native.native_metadata(family)
    for frame in meta["frames"]:
        url, params = native.route(meta["native_operation"], symbol, frame, 80)
        if family == "sina-a":
            assert params["scale"] == native.SCALES[frame] and params["symbol"] == "sh600519"
        elif frame in native.MINUTES:
            assert url == native.TENCENT_MINUTE_URL
            assert f',m{native.MINUTES[frame]},,' in params['param']
        else:
            assert url == (native.TENCENT_HK_URL if family == 'tencent-hk' else native.TENCENT_A_URL)
            assert f',{native.PERIODS[frame]},,,' in params['param']
            assert params['param'].endswith(',80,')


def test_tencent_array_order_compact_date_and_strict_selected_raw_series():
    def payload(key, rows):
        return json.dumps({'code': 0, 'data': {'sz000001': {key: rows}}})
    row = ['202611121030', '10', '11', '12', '9', '100']
    parsed = native.parse_response('native_tencent_a', 'SZSE:000001', 'H1', payload('m60', [row]))
    assert parsed == [{'date': '2026-11-12 10:30:00', 'open': '10', 'close': '11',
                       'high': '12', 'low': '9', 'volume': '100'}]
    for data in (payload('qfqmonth', [row]), payload('day', [row]), json.dumps({'code': -1})):
        with pytest.raises(ValueError):
            native.parse_response('native_tencent_a', 'SZSE:000001', 'MN', data)


def test_sina_jsonp_is_parsed_without_executing_javascript():
    row = {'day': '2026-11-12', 'open': '10', 'close': '11', 'high': '12', 'low': '9', 'volume': '1'}
    result = native.parse_response('native_sina_a', 'SZSE:000001', 'D1', '/* source */=(' + json.dumps([row]) + ');')
    assert result[0]['date'] == row['day']
    for text in ('=(null);', 'alert(1)', '=([]); process.exit()'):
        with pytest.raises(ValueError):
            native.parse_response('native_sina_a', 'SZSE:000001', 'D1', text)


@pytest.mark.parametrize('operation,symbol,frame', [
    ('native_sina_a', 'HKEX:00700', 'D1'), ('native_tencent_hk', 'HKEX:00700', 'M1'),
    ('native_tencent_a', 'BSE:920001', 'D1'), ('native_tencent_a', 'SHFE:RB0', 'D1')])
def test_out_of_scope_routes_are_rejected(operation, symbol, frame):
    with pytest.raises(ValueError):
        native.route(operation, symbol, frame, 80)


def records(*labels):
    return [{'date': label, 'open': '10', 'close': '11', 'high': '12', 'low': '9', 'volume': '100'}
            for label in labels]


@pytest.mark.parametrize('frame,first,updated,expected', [
    ('W1', '2026-11-11', '2026-11-12', '2026-11-09'),
    ('MN', '2026-11-11', '2026-11-12', '2026-11-01')])
def test_changing_period_source_label_has_stable_key_and_current_period_is_unconfirmed(frame, first, updated, expected):
    meta = {**native.native_metadata('sina-a'), 'symbol': 'SZSE:000001'}
    source = native.source_identity(meta, frame)
    now = stamp('2026-11-13')
    rows = [provider.parse_records(source, records(label), start=0, end=now, observed_at=now)[0]
            for label in (first, updated)]
    assert rows[0].start == rows[1].start == stamp(expected)
    assert rows[0].trading_date != rows[1].trading_date
    assert not any(row.complete for row in rows)


def test_minute_close_labels_have_correct_local_to_utc_bounds():
    source = native.source_identity({**native.native_metadata('tencent-a'), 'symbol': 'SZSE:000001'}, 'H1')
    row = provider.parse_records(source, records('2026-11-12 10:30:00'),
        start=0, end=stamp('2026-11-13'), observed_at=stamp('2026-11-13'))[0]
    assert row.start == stamp('2026-11-12') + 90 * 60000
    assert row.end == stamp('2026-11-12') + 150 * 60000


def test_platform_variants_page_counts_descriptions_and_managed_exclusion(database, monkeypatch):
    from alerts.instrument_directory import search
    from alerts.platform_catalog import catalog
    from alerts.provider_chart import metadata

    monkeypatch.setattr(settings, 'akshare_enabled', True)
    with database.begin() as db:
        for symbol, label in [('SZSE:000001', '平安银行'), ('HKEX:00700', '腾讯控股')]:
            db.add(MarketCatalog(id=stable_id(symbol), source='akshare', symbol=symbol, label=label,
                asset_type='EQUITY', precision=4, calendar='source_date', available=True,
                metadata_json={**details(symbol), 'name_zh': '自定' + label}, updated_at=0))
    with database() as db:
        page = catalog(db, source='akshare', page_size=100)
        assert page['total'] == len(page['items']) == 6
        paged = [catalog(db, source='akshare', page_size=1, page=p)['items'][0]['id'] for p in range(1, 7)]
        assert len(set(paged)) == 6
        assert len(search(db, source='akshare', managed=True)['items']) == 2
    for row in page['items']:
        resolved = metadata(row['id'])
        assert resolved['name_zh'].startswith('自定')
        if row['id'].startswith(native.PREFIXES):
            assert row['price_basis_display'] == resolved['price_basis_display'] == '不复权'
            assert row['capabilities']['native_periods'] == resolved['frames']
            assert row['capabilities']['supported_modes'] == row['managed_datasets'] == []
            assert row['history_catalog_id'] == stable_id(row['symbol'])
            assert resolved['adjustment'] == 'none'
        else:
            assert resolved['frames'] == ['D1'] and resolved['adjustment'] == 'qfq'
    hk = next(row for row in page['items'] if row['id'] == 'TENCENT-NATIVE:HKEX:00700')
    assert hk['provider_name'] == '腾讯（AKShare）'


def test_native_source_and_provider_cache_are_isolated_from_legacy_qfq():
    from alerts.history_mode_sources import dataset_identity
    from alerts.provider_cache import identity

    meta = {'source': 'akshare', 'symbol': 'SZSE:000001', 'basis': 'last', 'calendar': 'source_date'}
    legacy = {**meta, 'source_family': 'sina-a', 'adjustment': 'qfq'}
    raw = {**meta, **native.native_metadata('sina-a')}
    assert identity(raw, 'D1') != identity(legacy, 'D1')
    assert native.source_identity(raw, 'D1').key != provider.collection_identity(
        dataset_identity('akshare', meta['symbol'], 'native_periods', 'none'), 'D1').key
    assert provider.supported_frames(meta['symbol'], 'sina-a') == ['D1']


def test_snapshot_cursors_across_minutes_reuse_fetch_and_stop_at_finite_window(database, monkeypatch):
    calls = []
    now = [stamp('2026-11-13') + 20000]
    monkeypatch.setattr(provider, 'invoke', lambda op, params, **kw: calls.append((op, params)) or records(
        '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12'))
    monkeypatch.setattr('alerts.storage.now_ms', lambda: now[0])
    meta = {**native.native_metadata('sina-a'), 'symbol': 'SZSE:000001', 'precision': 4}
    first = native.platform_page(meta, 'D1', now[0], 2)
    assert first['has_more'] and len(first['bars']) == 2
    now[0] += 70000
    older = native.platform_page(meta, 'D1', first['bars'][0]['start'], 2)
    assert len(calls) == 1 and len(older['bars']) == 2 and not older['has_more']
    assert older['boundary_evidence']['kind'] == 'rolling_window'
    assert older['history_boundary'] is False
    assert not native.platform_page(meta, 'D1', older['bars'][0]['start'], 2)['bars']
    assert len(calls) == 1


def test_failure_releases_shared_snapshot_for_retry(database, monkeypatch):
    calls = []
    def invoke(*args, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            raise TimeoutError('unavailable')
        return records('2026-11-12')
    monkeypatch.setattr(provider, 'invoke', invoke)
    meta = {**native.native_metadata('tencent-hk'), 'symbol': 'HKEX:00700', 'precision': 4}
    with pytest.raises(TimeoutError):
        native.platform_page(meta, 'D1', stamp('2026-11-13'), 10)
    assert native.platform_page(meta, 'D1', stamp('2026-11-13'), 10)['bars']
    assert len(calls) == 2


def test_worker_native_operation_does_not_import_sdk():
    script = '''
import io, json, sys
from alerts import akshare_worker as worker
worker.fetch = lambda *a, **kw: [{'date':'2026-11-12'}]
sys.stdin = io.StringIO(json.dumps({'endpoint':'native_sina_a','parameters':{}}))
worker.main()
assert 'akshare' not in sys.modules
'''
    result = subprocess.run([sys.executable, '-c', script], text=True, capture_output=True, check=True)
    assert json.loads(result.stdout)['status'] == 'data'


def test_invalid_supplier_observation_is_audited_and_survives_shared_cache(database, monkeypatch):
    calls = []
    bad = {**records('1992-08-31')[0], 'open': '46.600', 'high': '46.500', 'low': '40.300', 'close': '41.250'}
    monkeypatch.setattr(provider, 'invoke', lambda *a, **kw: calls.append(1) or [bad, *records('2026-10-30', '2026-11-12')])
    meta = {**native.native_metadata('sina-a'), 'symbol': 'SZSE:000001', 'precision': 4}
    first = native.platform_page(meta, 'MN', stamp('2026-11-13'), 100)
    second = native.platform_page(meta, 'MN', stamp('2026-11-13'), 100)
    assert len(first['bars']) == 2 and len(calls) == 1
    assert first['source_warnings'] == second['source_warnings'] == [{
        'source_label': '1992-08-31', 'reason': 'invalid_supplier_ohlcv',
        'record': {key: bad[key] for key in ('open', 'high', 'low', 'close', 'volume')}}]
    assert all(bar['high'] == '12' for bar in first['bars'])


def test_inflight_snapshot_uses_existing_shared_lease_without_second_supplier_call(database, monkeypatch):
    from alerts.source_history_store import AcquisitionBusy

    meta = {**native.native_metadata('tencent-a'), 'symbol': 'SZSE:000001', 'precision': 4}
    calls = []
    def invoke(*args, **kwargs):
        calls.append(1)
        with pytest.raises(AcquisitionBusy):
            native.platform_page(meta, 'D1', stamp('2026-11-13'), 100)
        return records('2026-11-12')
    monkeypatch.setattr(provider, 'invoke', invoke)
    assert native.platform_page(meta, 'D1', stamp('2026-11-13'), 100)['bars']
    assert len(calls) == 1


def test_provider_cache_stops_at_snapshot_edge_after_minute_refresh_deadline(database, monkeypatch):
    from alerts import provider_cache as cache

    now = [stamp('2026-11-13') + 20000]
    monkeypatch.setattr('alerts.storage.now_ms', lambda: now[0])
    monkeypatch.setattr(cache, 'now_ms', lambda: now[0])
    calls = []
    monkeypatch.setattr(provider, 'invoke', lambda *a, **kw: calls.append(1) or records('2026-11-12'))
    meta = {**native.native_metadata('sina-a'), 'id': 'SINA-NATIVE:SZSE:000001',
            'source': 'akshare', 'symbol': 'SZSE:000001', 'precision': 4,
            'basis': 'last', 'calendar': 'source_date'}
    first = cache.read(meta, 'D1', now[0], 2, deadline=time.monotonic() + 2)
    assert first['window_limit'] and len(first['bars']) == 1
    now[0] += 70000
    older = cache.read(meta, 'D1', stamp('2026-11-11'), 2, deadline=time.monotonic() + 2)
    assert older['window_limit'] and not older['bars'] and len(calls) == 1
    assert not older['history_boundary']


def test_empty_snapshot_does_not_poison_historical_cache_and_recovers(database, monkeypatch):
    from alerts import provider_cache as cache
    from alerts.market_contracts import MarketRequestError

    calls = []
    def invoke(*args, **kwargs):
        calls.append(1)
        return [] if len(calls) == 1 else records('2026-11-10')
    monkeypatch.setattr(provider, 'invoke', invoke)
    meta = {**native.native_metadata('tencent-a'), 'id': 'TENCENT-NATIVE:SZSE:000001',
            'source': 'akshare', 'symbol': 'SZSE:000001', 'precision': 4,
            'basis': 'last', 'calendar': 'source_date'}
    with pytest.raises(MarketRequestError):
        cache.read(meta, 'D1', stamp('2026-11-11'), 2, deadline=time.monotonic() + 2)
    second = cache.read(meta, 'D1', stamp('2026-11-11'), 2, deadline=time.monotonic() + 2)
    assert len(second['bars']) == 1 and len(calls) == 2
    assert not second['history_boundary']


def test_new_ticker_round_trip_and_chart_budget():
    from alerts.chart_series import decode, encode
    from alerts.provider_capabilities import instrument_source
    for symbol in ('SINA-NATIVE:SSE:600519', 'TENCENT-NATIVE:HKEX:00700'):
        ticker = encode(symbol, 'provider')
        assert decode(ticker) == (symbol, 'provider')
        assert instrument_source(ticker) == 'akshare'
