"""Native history must progress alongside the account's shared latest candles."""
import time

import pytest
from sqlalchemy import select

from alerts import provider_cache as cache, provider_chart as upstream
from alerts.chart_api import DataQuery
from alerts.config import settings
from alerts.native_history_loads import read_context
from alerts.storage import ProviderDataset, ProviderInterest

META = {'id': 'OANDA:EUR_USD', 'symbol': 'EUR_USD', 'source': 'oanda',
        'basis': 'bid', 'calendar': 'ny17', 'precision': 5}
NOW = 630000


def bars(start, end, *, complete=True):
    return [{'start': t, 'end': t + 60000, 'chart_time': t,
             'open': '1.1', 'high': '1.2', 'low': '1.0', 'close': '1.1',
             'complete': complete} for t in range(start, end, 60000)]


def own(database, monkeypatch, start=0, *, gap=False, stale=False):
    monkeypatch.setattr(cache, 'now_ms', lambda: NOW)
    monkeypatch.setattr(settings, 'oanda_acquisition_mode', 'rest_batch')
    monkeypatch.setattr(upstream, 'metadata', lambda _: META)
    key = cache.ensure(META, 'M1')
    lease = cache.claim(key)
    confirmed = bars(start, 480000 if gap else 600000)
    cache.commit_page(key, lease, {'bars': confirmed + bars(600000, 660000, complete=False),
        'history_boundary': False, 'coverage': [[start, 480000 if gap else 600000]]},
        NOW, NOW - (20000 if stale else 0), latest=True)
    cache.release(key, lease)
    with database.begin() as db:
        db.add(ProviderInterest(id='native-test-owner', client='native-test-client', listener='chart-1',
            dataset_id=key, accessed_at=NOW,
            subscribed=True, expires=NOW + 60000))
    return key


def query():
    return DataQuery(instrument=META['id'], series_kind='provider', timeframe='M1',
                     limit=5, native_history={'chart_count': 1, 'focused': True})


def test_fresh_forming_tail_is_readable_without_claiming_coverage(database, monkeypatch):
    key = own(database, monkeypatch)
    monkeypatch.setattr(upstream, 'native_page', lambda *a, **kw: pytest.fail('shared latest must not be polled twice'))
    result = cache.data(query())
    assert len(result['bars']) >= 5
    assert result['bars'][-1]['start'] == 600000
    assert not result['bars'][-1]['complete']
    with database.begin() as db:
        assert db.get(ProviderDataset, key).coverage == [[0, 600000]]


def test_shared_latest_does_not_block_missing_history(database, monkeypatch):
    key = own(database, monkeypatch, start=540000)
    calls = []
    def fetch(meta, frame, before, count, **kw):
        calls.append((before, count))
        return {'bars': bars(before-count*60000, before), 'history_boundary': False}
    monkeypatch.setattr(upstream, 'native_page', fetch)
    progress = {'attempts': 0, 'pages': 0, 'advanced': False}
    with read_context('step', time.monotonic()+5, progress):
        result = cache.data(query())
    assert len(result['bars']) >= 5
    assert calls and calls[0][0] == 540000
    assert progress['pages'] == 1 and progress['advanced']
    with database.begin() as db:
        assert db.get(ProviderDataset, key).latest_at == NOW


def test_stale_shared_tail_waits_without_independent_poll(database, monkeypatch):
    own(database, monkeypatch, stale=True)
    monkeypatch.setattr(upstream, 'native_page', lambda *a, **kw: pytest.fail('stale shared latest belongs to account worker'))
    with pytest.raises(cache.HistoryPending):
        cache.data(query())


def test_missing_minutes_require_a_real_history_page(database, monkeypatch):
    key = own(database, monkeypatch, gap=True)
    monkeypatch.setattr(upstream, 'native_page', lambda *a, **kw: (_ for _ in ()).throw(TimeoutError('history unavailable')))
    with pytest.raises(TimeoutError, match='history unavailable'):
        cache.data(query())
    with database.begin() as db:
        assert db.get(ProviderDataset, key).coverage == [[0, 480000]]


def test_durable_load_waits_for_shared_refresh_and_keeps_its_deadline(database, monkeypatch):
    from alerts import native_history_loads as loads
    from alerts.storage import NativeHistoryLoad
    key = own(database, monkeypatch, stale=True)
    clock = [NOW]
    monkeypatch.setattr(cache, 'now_ms', lambda: clock[0])
    monkeypatch.setattr(loads, 'now_ms', lambda: clock[0])
    monkeypatch.setattr(upstream, 'native_page', lambda *a, **kw: pytest.fail('shared refresh must not fall back to polling'))
    ident = loads.submit('owner', 'shared-refresh', query())['load']['id']
    for _ in range(4):
        assert loads.once()
        state = loads.status('owner', ident)
        assert state['state'] == 'waiting' and state['error'] is None
        with database.begin() as db:
            row = db.get(NativeHistoryLoad, ident)
            assert row.stalls == 0
            assert row.lease_until > clock[0], 'waiting must yield instead of tight polling'
        clock[0] += 1000
    with database.begin() as db:
        db.get(ProviderDataset, key).latest_at = clock[0]
    assert loads.once()
    assert loads.status('owner', ident)['state'] == 'ready'
    assert len(loads.result('owner', ident)['result']['bars']) >= 5
    with database.begin() as db:
        db.get(ProviderDataset, key).latest_at = clock[0] - 20000
    expired = loads.submit('owner', 'expired-refresh', query())['load']['id']
    with database.begin() as db:
        db.get(NativeHistoryLoad, expired).deadline = clock[0] - 1
    assert not loads.once()
    assert loads.status('owner', expired)['state'] == 'expired'
