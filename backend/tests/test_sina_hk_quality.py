"""Legacy HK platform recovery must not alter valid prices or managed reads."""

import json
from pathlib import Path

import pytest
from alerts import provider_akshare as source
from alerts import provider_cache
from alerts.akshare_catalog import chart_metadata, details, stable_id
from alerts.config import settings
from alerts.history_mode_sources import dataset_identity
from alerts.market_contracts import MarketRequestError
from alerts.platform_catalog import catalog
from alerts.storage import MarketCatalog, SourceFetch, SourceSeries
from sqlalchemy import select
from test_native_history_archive import stamp

POLICY = 'sina-hk-platform-invalid-ohlcv-audit-v1'
FIXTURE = Path(__file__).resolve().parents[2] / 'docs/research/evidence/sina-hk-ohlc-20261112/00700-minimal.json'


def records():
    return json.loads(FIXTURE.read_text())['qfq']


def meta():
    return {'id': stable_id('HKEX:00700'), 'source': 'akshare', 'symbol': 'HKEX:00700',
            'source_family': 'sina-hk', 'frames': ['D1'], 'adjustment': 'qfq',
            'precision': 5, 'volume_kind': 'quantity', 'volume_unit': 'shares',
            'basis': 'last', 'calendar': 'source_date'}


def test_real_bad_historical_rows_do_not_block_recent_platform_or_cached_reads(database, monkeypatch):
    before = stamp('2026-11-13')
    monkeypatch.setattr(source, 'now_ms', lambda: before)
    monkeypatch.setattr('alerts.source_history_store.now_ms', lambda: before)
    calls = []
    monkeypatch.setattr(source, 'invoke', lambda name, params, **kw: calls.append((name, params)) or records())
    first = source.platform_page(meta(), 'D1', before, 2)
    cached = source.platform_page(meta(), 'D1', before - 1000, 2)
    assert len(first['bars']) == len(cached['bars']) == 2
    assert first['source_warnings'] == cached['source_warnings']
    assert [w['source_label'] for w in first['source_warnings']] == ['2006-06-13', '2009-01-01']
    original = {r['date']: r for r in records()}
    assert all(all(row[key] == original[row['source_label']][key]
                   for key in ('open', 'high', 'low', 'close', 'volume')) for row in first['bars'])
    assert all(w['reason'] == 'invalid_supplier_ohlcv' for w in first['source_warnings'])
    assert first['source_warnings'][0]['record']['low'] == '2.8475'
    assert calls == [('stock_hk_daily', {'symbol': '00700', 'adjust': 'qfq'})]
    strict = source.collection_identity(dataset_identity('akshare', 'HKEX:00700', 'native_periods', 'none'), 'D1')
    strict_qfq = strict.model_copy(update={'parameters': {**strict.parameters, 'adjustment': 'qfq'}})
    with database() as db:
        saved = list(db.scalars(select(SourceSeries)))
        assert len(saved) == 1
        assert saved[0].identity['parameters']['record_policy'] == POLICY
        assert saved[0].id != strict_qfq.key
        assert 'record_policy' not in strict.parameters


def test_hk_audit_reaches_provider_cache_and_metadata_without_changing_ticker(database, monkeypatch):
    from alerts import provider_chart

    monkeypatch.setattr(settings, 'akshare_enabled', True)
    before = stamp('2026-11-13')
    monkeypatch.setattr(source, 'now_ms', lambda: before)
    monkeypatch.setattr(source, 'invoke', lambda *a, **kw: records())
    monkeypatch.setattr(provider_chart, 'native_page', source.platform_page)
    with database.begin() as db:
        db.add(MarketCatalog(id=meta()['id'], source='akshare', symbol='HKEX:00700', label='腾讯控股',
            asset_type='EQUITY', precision=5, calendar='source_date', available=True,
            metadata_json=details('HKEX:00700', {'none': ['D1']}), updated_at=0))
    metadata = chart_metadata(meta()['id'])
    assert metadata['id'] == meta()['id'] and metadata['adjustment'] == 'qfq'
    assert '异常' in metadata['quality_note']
    with database() as db:
        listed = catalog(db, query='00700', source='akshare')['items']
    legacy = next(r for r in listed if r['id'] == meta()['id'])
    assert legacy['quality_note'] == metadata['quality_note']
    assert all(not r['quality_note'] for r in listed if r['id'].startswith('TENCENT-NATIVE:'))
    key = provider_cache.ensure(metadata, 'D1')
    page = provider_cache.read(metadata, 'D1', before, 2)
    cached = provider_cache.snapshot(key, before, 2)
    assert len(page['bars']) == 2
    assert cached['source_warnings'] == page['source_warnings']
    assert len(cached['source_warnings']) == 2


@pytest.mark.parametrize('payload', [records()[:2], []])
def test_no_valid_hk_snapshot_is_retryable_and_not_cached_as_empty_success(database, monkeypatch, payload):
    before = stamp('2026-11-13')
    monkeypatch.setattr(source, 'now_ms', lambda: before)
    calls = []
    monkeypatch.setattr(source, 'invoke', lambda *a, **kw: calls.append(1) or (payload if len(calls) == 1 else records()))
    with pytest.raises(MarketRequestError):
        source.platform_page(meta(), 'D1', before, 2)
    with database() as db:
        assert all(fetch.content_id is None and fetch.lease_until == 0 for fetch in db.scalars(select(SourceFetch)))
    assert len(source.platform_page(meta(), 'D1', before, 2)['bars']) == 2
    assert len(calls) == 2


def test_legacy_managed_and_unopted_qfq_stay_strict(monkeypatch):
    monkeypatch.setattr(source, 'invoke', lambda *a, **kw: records())
    strict = source.collection_identity(dataset_identity('akshare', 'HKEX:00700', 'native_periods', 'none'), 'D1')
    for identity in (strict, strict.model_copy(update={'parameters': {**strict.parameters, 'adjustment': 'qfq'}})):
        with pytest.raises(ValueError, match='Invalid OHLC extremes'):
            source.AKShareHistory().native_page(identity, 0, stamp('2026-11-13'))


@pytest.mark.parametrize('patch', [{'close': None}, {'close': 'not-a-price'}])
def test_hk_platform_does_not_hide_missing_or_unparseable_prices(database, monkeypatch, patch):
    monkeypatch.setattr(source, 'now_ms', lambda: stamp('2026-11-13'))
    monkeypatch.setattr(source, 'invoke', lambda *a, **kw: [{**records()[-1], **patch}])
    with pytest.raises((ValueError, ArithmeticError)):
        source.platform_page(meta(), 'D1', stamp('2026-11-13'), 2)


@pytest.mark.parametrize('patch', [{'record_policy': 'unknown'}, {'adjustment': 'none'}])
def test_audit_policy_cannot_silently_apply_to_another_source_contract(monkeypatch, patch):
    strict = source.collection_identity(dataset_identity('akshare', 'HKEX:00700', 'native_periods', 'none'), 'D1')
    selected = strict.model_copy(update={'parameters': {
        **strict.parameters, 'adjustment': 'qfq', 'record_policy': POLICY, **patch}})
    monkeypatch.setattr(source, 'invoke', lambda *a, **kw: pytest.fail('invalid policy must not reach upstream'))
    with pytest.raises(ValueError, match='record policy'):
        source.AKShareHistory().native_page(selected, 0, stamp('2026-11-13'))
