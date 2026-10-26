"""Native history must progress alongside the account's shared latest candles."""
import time

import pytest
from alerts import provider_cache as cache
from alerts import provider_chart as upstream
from alerts.chart_query import DataQuery
from alerts.config import settings
from alerts.native_history_loads import read_context
from alerts.storage import ProviderDataset, ProviderInterest

META = {'id': 'OANDA:EUR_USD', 'symbol': 'EUR_USD', 'source': 'oanda',
        'basis': 'bid', 'calendar': 'ny17', 'precision': 5}
NOW = 630000


@pytest.fixture(autouse=True)
def oanda_account(monkeypatch):
    monkeypatch.setattr(settings, "oanda_account_id", "native-history-account")


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


@pytest.mark.parametrize("count_to_coverage", [False, True])
def test_indicator_read_uses_adjacent_forming_without_repoll(database, monkeypatch, count_to_coverage):
    key = own(database, monkeypatch)
    if count_to_coverage:
        with database.begin() as db:
            db.get(ProviderDataset, key).coverage = [[0, 600001]]
    monkeypatch.setattr(upstream, 'native_page', lambda *a, **kw: pytest.fail('indicator must use the shared observation'))
    body = DataQuery(instrument=META['id'], series_kind='provider', timeframe='M1',
                     before=600001, limit=5, firstDataRequest=False,
                     indicators=[{'name':'SUPERTREND_PINE_V1',
                                  'params':{'period':2, 'multiplier':3, 'source':'hl2', 'atr_method':'wilder'}}])
    assert body.native_history is None
    result = cache.data(body)
    assert len(result['bars']) == 5
    assert result['bars'][-1]['start'] == 600000
    assert any(s['values'] for s in result['indicators'][0]['series'])
    assert bool(cache.snapshot(key, 600001, 5)['interval']) == count_to_coverage


def test_indicator_read_still_fetches_missing_prefix(database, monkeypatch):
    key = own(database, monkeypatch, start=540000)
    calls = []

    def fetch(meta, frame, before, count, **kwargs):
        calls.append((before, count))
        return {'bars': bars(before-count*60000, before), 'history_boundary': False}

    monkeypatch.setattr(upstream, 'native_page', fetch)
    result = cache.data(DataQuery(instrument=META['id'], series_kind='provider', timeframe='M1',
        before=600001, limit=5, firstDataRequest=False,
        indicators=[{'name': 'SUPERTREND_PINE_V1', 'params': {'period': 2}}]))
    assert calls == [(540000, 5)]
    assert len(result['bars']) == 5
    assert result['bars'][-1]['start'] == 600000
    assert cache.snapshot(key, 600001, 5)['interval'] is None


def test_ordinary_read_requires_real_coverage_across_a_gap(database, monkeypatch):
    key = own(database, monkeypatch, gap=True)
    monkeypatch.setattr(upstream, 'native_page', lambda *a, **kw: (_ for _ in ()).throw(TimeoutError('uncovered gap')))
    with pytest.raises(TimeoutError, match='uncovered gap'):
        cache.read(META, 'M1', 600001, 5)
    assert cache.snapshot(key, 600001, 5)['interval'] is None


def test_ordinary_latest_read_waits_for_shared_freshness(database, monkeypatch):
    own(database, monkeypatch, stale=True)
    monkeypatch.setattr(upstream, 'native_page', lambda *a, **kw: pytest.fail('latest must remain account-owned'))
    with pytest.raises(cache.LatestObservationPending):
        cache.read(META, 'M1', 600001, 5, latest=True)


def test_ordinary_latest_read_fetches_real_gap_beside_shared_owner(database, monkeypatch):
    own(database, monkeypatch, gap=True)
    calls = []

    def fetch(meta, frame, before, count, **kwargs):
        calls.append((before, count))
        return {'bars': bars(360000, 600000) + bars(600000, 660000, complete=False),
                'history_boundary': False, 'coverage': [[360000, before]]}

    monkeypatch.setattr(upstream, 'native_page', fetch)
    result = cache.read(META, 'M1', 600001, 5, latest=True)
    assert calls == [(600001, 5)]
    assert [b['start'] for b in result['bars']] == list(range(360000, 660000, 60000))


@pytest.mark.parametrize('frame,opening,observed', [
    ('D1', '2026-10-15T21:00:00+00:00', '2026-10-15T21:30:00+00:00'),
    ('W1', '2026-10-11T21:00:00+00:00', '2026-10-11T21:30:00+00:00'),
    ('MN', '2026-09-30T21:00:00+00:00', '2026-09-30T21:30:00+00:00'),
])
@pytest.mark.parametrize('native', [False, True])
@pytest.mark.parametrize('explicit_margin', [False, True])
def test_first_high_period_price_admits_source_before_future_date_label(
        database, monkeypatch, frame, opening, observed, native, explicit_margin):
    from datetime import datetime

    from alerts import native_series
    from alerts.storage import ProviderBar
    from sqlalchemy import select

    def stamp(value):
        return int(datetime.fromisoformat(value).timestamp() * 1000)
    clock, start = stamp(observed), stamp(opening)
    monkeypatch.setattr(cache, 'now_ms', lambda: clock)
    monkeypatch.setattr(settings, 'oanda_acquisition_mode', 'rest_batch')
    monkeypatch.setattr(settings, 'provider_native_history_buffer', False)
    monkeypatch.setattr(upstream, 'metadata', lambda _: META)
    native_params = native_series.DEFAULTS
    label = native_series.chart_label(start, frame, native_params)
    assert start <= clock < label
    end = native_series.interval_end(start, frame, native_params)
    previous = start - (86400000 if frame == 'D1' else 7 * 86400000 if frame == 'W1' else 30 * 86400000)

    def candle(at, finish, complete):
        return {'start': at, 'end': finish,
                'chart_time': native_series.chart_label(at, frame, native_params),
                'open': '1.1', 'high': '1.2', 'low': '1.0', 'close': '1.15', 'complete': complete}

    key = cache.ensure(META, frame)
    lease = cache.claim(key)
    cache.commit_page(key, lease, {'bars': [candle(previous, start, True), candle(start, end, False)],
        'history_boundary': True, 'coverage': [[0, start]]}, clock, clock, latest=True)
    cache.release(key, lease)
    # A cached future source row must not enter either prices or credentials.
    with database.begin() as db:
        future = candle(end, native_series.interval_end(end, frame, native_params), False)
        db.add(ProviderBar(dataset_id=key, start=end, chart_time=future['chart_time'],
            complete=False, payload=future, observed_at=clock, changed_at=clock, revision=1))
        db.add(ProviderInterest(id='date-label-owner', client='date-label-client', listener='chart',
            dataset_id=key, accessed_at=clock, subscribed=True, expires=clock + 60000))
    monkeypatch.setattr(upstream, 'native_page', lambda *a, **kw: pytest.fail('fresh covered source must be readable'))
    body = DataQuery(instrument=META['id'], series_kind='provider', timeframe=frame, limit=1,
        before=label + 2 * 86400000 if explicit_margin else None, firstDataRequest=True,
        native_history={'chart_count': 1, 'focused': True} if native else None)
    result = cache.data(body)
    assert result['bars'][-1]['start'] == start
    assert result['bars'][-1]['chart_time'] == label
    assert all(bar['start'] <= clock for bar in result['bars'])
    bound = cache.data(DataQuery(instrument=META['id'], series_kind='provider', timeframe=frame,
        before=label+1, limit=1, provider_snapshot_id=result['provider_snapshot_id'],
        indicators=[{'name': 'SWING_SR_V1'}]))
    assert bound['bars'] == result['bars']
    assert bound['indicators'][0]['presentation']['as_of_bar_time'] == start
    with database.begin() as db:
        assert db.get(ProviderDataset, key).coverage == [[0, start]]
        assert len(list(db.scalars(select(ProviderBar).where(ProviderBar.dataset_id == key)))) == 3


@pytest.mark.parametrize('native', [False, True])
@pytest.mark.parametrize('minute_handoff', [False, True])
def test_cold_latest_recovers_supplier_clock_rejection_after_queue(database, monkeypatch, native, minute_handoff):
    from datetime import datetime
    from decimal import Decimal

    import httpx

    entry = int(datetime.fromisoformat('2026-10-16T02:59:59.900+00:00' if minute_handoff else
        '2026-10-16T03:00:00.900+00:00').timestamp() * 1000)
    observed = entry + 200
    opening = entry // 60000 * 60000
    before = (entry // 1000 + 1) * 1000
    monkeypatch.setattr(cache, 'now_ms', lambda: entry)
    monkeypatch.setattr(upstream, 'now_ms', lambda: observed)
    monkeypatch.setattr(upstream, 'metadata', lambda _: META)
    monkeypatch.setattr(settings, 'oanda_token', 'test-only')
    monkeypatch.setattr(settings, 'oanda_acquisition_mode', 'rest_batch')
    monkeypatch.setattr(settings, 'provider_native_history_buffer', False)
    calls = []

    def handle(request):
        params = dict(request.url.params)
        calls.append(params)
        if 'to' in params:
            assert Decimal(params['to']) * 1000 == before
            if len(calls) == 1:
                assert Decimal(params['to']) * 1000 > observed - 500
                return httpx.Response(400, json={'errorMessage': "Invalid value specified for 'to'. Time is in the future"})
        return httpx.Response(200, json={'candles': [
            {'time': str(Decimal(t) / 1000), 'complete': False,
             'bid': {'o': '1', 'h': '2', 'l': '1', 'c': '1.5'}}
            for t in ([before] if minute_handoff and 'to' not in params else [opening])
        ]})

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        monkeypatch.setattr(upstream, 'pooled_client', lambda _: client)
        result = cache.data(DataQuery(instrument=META['id'], series_kind='provider', timeframe='M1',
            limit=1, firstDataRequest=True, native_history={'chart_count': 1, 'focused': True} if native else None))
    assert len(calls) == (3 if minute_handoff else 2) and 'to' in calls[0] and 'to' not in calls[1]
    if minute_handoff:
        assert 'to' in calls[2]
    assert [b['start'] for b in result['bars']] == [opening]
    assert result['provider_snapshot_id']
    with database.begin() as db:
        assert all(end <= before for _, end in db.get(ProviderDataset, result['dataset_id']).coverage)
