import pytest
from alerts import provider_cache as cache
from alerts import provider_chart as upstream
from alerts.config import settings
from alerts.storage import Bar, ImportJob, ProviderBar, ProviderDataset
from sqlalchemy import func, select

META = {
    "id": "OANDA:CACHE_TEST",
    "symbol": "CACHE_TEST",
    "source": "oanda",
    "basis": "bid",
    "calendar": "ny17",
    "precision": 5,
}


def page(start, end, *, boundary=False, close="2", complete=True):
    return {
        "bars": [
            {
                "start": i,
                "end": i + 1000,
                "chart_time": i,
                "open": "1",
                "high": "3",
                "low": "0",
                "close": close,
                "complete": complete,
            }
            for i in range(start, end, 1000)
        ],
        "history_boundary": boundary,
    }


def seed(meta, frame, before, payload, *, latest=False):
    key = cache.ensure(meta, frame)
    lease = cache.claim(key)
    cache.commit_page(key, lease, payload, before, cache.now_ms(), latest=latest)
    cache.release(key, lease)
    return key


def test_cached_slice_shared_by_alias_not_http_request(database, monkeypatch):
    key = seed(META, "M5", 1000000, page(0, 1000000, boundary=True))
    monkeypatch.setattr(
        upstream, "native_page", lambda *a, **k: pytest.fail("cache must satisfy the slice")
    )
    alias = {**META, "id": "CACHE_ALIAS"}
    assert cache.identity(alias, "M5") == key
    result = cache.read(alias, "M5", 700000, 200)
    assert len(result["bars"]) == 200
    assert result["bars"][0]["start"] == 500000
    assert not result["history_boundary"], "more cached bars exist before this slice"
    assert cache.read(alias, "M5", 700000, 800)["history_boundary"]
    with database.begin() as db:
        assert db.scalar(select(func.count()).select_from(Bar)) == 0
        assert db.scalar(select(func.count()).select_from(ImportJob)) == 0


def test_large_count_fully_paginates_in_backend(database, monkeypatch):
    calls = []

    def fetch(meta, frame, before, count, **kwargs):
        calls.append(count)
        return page(before - count * 1000, before)

    monkeypatch.setattr(upstream, "native_page", fetch)
    result = cache.read(META, "M5", 6000000, 4500)
    assert calls == [4000, 500]
    assert len(result["bars"]) == 4500
    assert [b["start"] for b in result["bars"]] == list(range(1500000, 6000000, 1000))


def test_range_gap_is_not_inferred_from_min_max(database, monkeypatch):
    seed(META, "M5", 300000, page(200000, 300000))
    seed(META, "M5", 600000, page(500000, 600000))
    calls = []

    def fetch(meta, frame, before, count, **kwargs):
        calls.append((before, count))
        return page(before - count * 1000, before)

    monkeypatch.setattr(upstream, "native_page", fetch)
    result = cache.read(META, "M5", 600000, 300)
    assert calls == [(500000, 200)]
    assert len(result["bars"]) == 300


def test_stale_latest_refresh_only_fetches_tail(database, monkeypatch):
    clock = [1000000]
    monkeypatch.setattr(cache, "now_ms", lambda: clock[0])
    monkeypatch.setattr(settings, "provider_fresh_seconds", 15)
    key = seed(META, "M5", 1000000, page(0, 1000000), latest=True)
    clock[0] += 16000
    calls = []

    def fetch(meta, frame, before, count, **kwargs):
        calls.append(count)
        return page(before - count * 1000, before)

    monkeypatch.setattr(upstream, "native_page", fetch)
    assert len(cache.read(META, "M5", 1000000, 600, latest=True)["bars"]) == 600
    assert calls == [3]
    assert cache.snapshot(key, 1000000, 600)["latest_at"] == clock[0]


def test_expired_generation_cannot_commit_or_release_successor(database):
    key = cache.ensure(META, "M5")
    old = cache.claim(key)
    with database.begin() as db:
        db.get(ProviderDataset, key).lease_until = 0
    new = cache.claim(key)
    with pytest.raises(TimeoutError):
        cache.commit_page(key, old, page(1000, 3000), 3000, cache.now_ms())
    cache.release(key, old)
    with database.begin() as db:
        assert db.get(ProviderDataset, key).lease_token == new[0]
        assert db.scalar(select(func.count()).select_from(ProviderBar)) == 0
    cache.commit_page(key, new, page(1000, 3000), 3000, cache.now_ms())


def test_older_response_cannot_regress_complete_bar(database):
    key = seed(META, "M5", 2000, page(1000, 2000, complete=True, close="2"))
    lease = cache.claim(key)
    cache.commit_page(
        key, lease, page(1000, 2000, complete=False, close="1"), 2000, cache.now_ms() + 1
    )
    row = cache.snapshot(key, 2000, 1)["bars"][0]
    assert row["complete"] and row["close"] == "2"


def test_upstream_failure_does_not_publish_coverage(database, monkeypatch):
    def fail(*args, **kwargs):
        raise TimeoutError("fixture unavailable")

    monkeypatch.setattr(upstream, "native_page", fail)
    with pytest.raises(TimeoutError):
        cache.read(META, "M5", 1000000, 200)
    with database.begin() as db:
        dataset = db.get(ProviderDataset, cache.identity(META, "M5"))
        assert dataset.coverage == [] and not dataset.earliest
        assert dataset.lease_token is None


def test_cancelled_waiter_does_not_release_another_requests_lease(database):
    import threading

    key = cache.ensure(META, "M5")
    owner = cache.claim(key)
    cancelled = threading.Event()
    cancelled.set()
    token = cache.CANCELLED.set(cancelled)
    try:
        with pytest.raises(TimeoutError, match="取消"):
            cache.read(META, "M5", 10000, 3)
    finally:
        cache.CANCELLED.reset(token)
    with database.begin() as db:
        assert db.get(ProviderDataset, key).lease_token == owner[0]
    cache.commit_page(key, owner, page(7000, 10000), 10000, cache.now_ms())
    cache.release(key, owner)
    assert cache.read(META, "M5", 10000, 3)["cache_hit"]


def test_disjoint_preceding_cache_cannot_reduce_foreground_missing_count(database, monkeypatch):
    seed(META, "M5", 100000, page(1000, 100000))
    calls = []

    def fetch(meta, frame, before, count, **kwargs):
        calls.append(count)
        return page(before - count * 1000, before)

    monkeypatch.setattr(upstream, "native_page", fetch)
    result = cache.read(META, "M5", 1000000, 200)
    assert calls == [200]
    assert len(result["bars"]) == 200


def test_fresh_short_history_boundary_reuses_recent_tail_without_refetch(database, monkeypatch):
    clock = [10000]
    monkeypatch.setattr(cache, "now_ms", lambda: clock[0])
    seed(META, "MN", 10000, page(1000, 10000, boundary=True), latest=True)
    clock[0] += 3000
    monkeypatch.setattr(upstream, "native_page", lambda *a, **k: pytest.fail("fresh confirmed short history must be cached"))
    result = cache.read(META, "MN", 13000, 200, latest=True)
    assert result["cache_hit"] and result["history_boundary"] and not result["has_more"]
    assert len(result["bars"]) == 9
    calls = []
    def refresh(meta, frame, before, count, **kwargs):
        calls.append(count)
        return page(7000, 10000)
    monkeypatch.setattr(upstream, "native_page", refresh)
    clock[0] += 16000
    result = cache.read(META, "MN", clock[0], 200, latest=True)
    assert calls == [3], "stale short histories refresh the tail rather than redownloading all months"
    assert result["history_boundary"] and len(result["bars"]) == 9


def native_body(**kwargs):
    from alerts.chart_api import DataQuery
    return DataQuery(instrument=META['id'], series_kind='provider', timeframe='M5',
                     native_history={'chart_count': 1, 'focused': True}, **kwargs)


def test_native_range_demand_is_preserved_with_buffer_switch_off_and_on(database, monkeypatch):
    monkeypatch.setattr(upstream, 'metadata', lambda instrument: META)
    seed(META, 'M5', 5000000, page(0, 5000000, boundary=True))
    monkeypatch.setattr(upstream, 'native_page', lambda *a, **k: pytest.fail('mandatory cache hit'))
    body = native_body(before=5000000, countBack=200, **{'from': 4500000})
    monkeypatch.setattr(settings, 'provider_native_history_buffer', False)
    off = cache.data(body)
    monkeypatch.setattr(settings, 'provider_native_history_buffer', True)
    on = cache.data(body)
    assert off['mandatory_count'] == on['mandatory_count'] == 500
    assert len(off['bars']) == 500 and len(on['bars']) == 2500
    assert off['bars'] == on['bars'][-500:]
    assert off['cache_revision'] == on['cache_revision']
    assert on['cache_hit']


def test_native_missing_optional_or_disconnected_history_never_fetches(database, monkeypatch):
    monkeypatch.setattr(upstream, 'metadata', lambda instrument: META)
    monkeypatch.setattr(settings, 'provider_native_history_buffer', True)
    seed(META, 'M5', 1000000, page(0, 1000000))
    seed(META, 'M5', 5000000, page(4500000, 5000000))
    monkeypatch.setattr(upstream, 'native_page', lambda *a, **k: pytest.fail('no optional fetch'))
    result = cache.data(native_body(before=5000000, countBack=200, firstDataRequest=True))
    assert len(result['bars']) == 500
    assert result['bars'][0]['chart_time'] == 4500000
    assert result['cache_hit'] and not result['history_boundary']


def test_native_cold_range_requires_more_than_count_back(database, monkeypatch):
    monkeypatch.setattr(upstream, 'metadata', lambda instrument: META)
    monkeypatch.setattr(settings, 'provider_native_history_buffer', False)
    calls = []
    def fetch(meta, frame, before, count, **kwargs):
        calls.append((before, count))
        start = max(0, before - count * 1000)
        return page(start, before, boundary=start == 0)
    monkeypatch.setattr(upstream, 'native_page', fetch)
    result = cache.data(native_body(before=8000000, countBack=200, **{'from': 3500000}))
    assert len(result['bars']) == 4500
    assert result['bars'][0]['chart_time'] == 3500000
    assert len(calls) > 1, 'countBack alone cannot terminate the mandatory corridor'
    assert not result['cache_hit']


def test_native_capacity_exact_limit_and_one_over(database, monkeypatch):
    from alerts.provider_history_policy import CapacityExceeded
    monkeypatch.setattr(upstream, 'metadata', lambda instrument: META)
    monkeypatch.setattr(settings, 'provider_native_history_buffer', True)
    # Commit in legal upstream chunks, not one oversized PostgreSQL insert.
    for start in range(0, 24000000, 4000000):
        seed(META, 'M5', start + 4000000, page(start, start + 4000000))
    monkeypatch.setattr(upstream, 'native_page', lambda *a, **k: pytest.fail('cached capacity test'))
    result = cache.data(native_body(before=24000000, countBack=200, **{'from': 4000000}))
    assert len(result['bars']) == 20000 and result['optional_count'] == 0
    with pytest.raises(CapacityExceeded):
        cache.data(native_body(before=24000000, countBack=200, **{'from': 3999000}))


def test_native_future_empty_range_and_confirmed_young_boundary(database, monkeypatch):
    monkeypatch.setattr(cache, 'now_ms', lambda: 1000000)
    monkeypatch.setattr(upstream, 'metadata', lambda instrument: META)
    monkeypatch.setattr(settings, 'provider_native_history_buffer', False)
    seed(META, 'M5', 1001000, page(995000, 1001000, boundary=True), latest=True)
    monkeypatch.setattr(upstream, 'native_page', lambda *a, **k: pytest.fail('empty future range'))
    result = cache.data(native_body(before=2000000, countBack=200,
                                   firstDataRequest=True, **{'from': 1500000}))
    assert len(result['bars']) == 6 and result['history_boundary']
    assert all(b['chart_time'] < 1001000 for b in result['bars'])


def test_native_python_uses_identical_real_demand_and_prefix_with_e_on_off(database, monkeypatch):
    monkeypatch.setattr(upstream, 'metadata', lambda instrument: META)
    seed(META, 'M5', 5000000, page(0, 5000000, boundary=True))
    body = native_body(before=5000000, countBack=200, **{'from': 4500000},
                       indicators=[{'name': 'EMA', 'params': {'period': 20}}])
    monkeypatch.setattr(settings, 'provider_native_history_buffer', False)
    off = cache.data(body)
    monkeypatch.setattr(settings, 'provider_native_history_buffer', True)
    on = cache.data(body)
    assert len(off['bars']) == len(on['bars']) == 500
    assert off['bars'] == on['bars'] and off['indicators'] == on['indicators']
    assert on['optional_count'] == 0


def test_native_observation_checks_inclusive_last_and_ignores_backfill(database, monkeypatch):
    clock = [10000000]
    monkeypatch.setattr(cache, 'now_ms', lambda: clock[0])
    monkeypatch.setattr(upstream, 'metadata', lambda instrument: META)
    seed(META, 'M5', 1000000, page(500000, 1000000))
    original = cache.data(native_body(before=1000000, countBack=200))
    body = native_body(before=1000000, countBack=200, history_observation={
        'revision': original['cache_revision'], 'observed_at': original['as_of'],
        'first': original['bars'][0]['chart_time'], 'last': original['bars'][-1]['chart_time']})
    clock[0] += 1000
    seed(META, 'M5', 500000, page(0, 500000, boundary=True))
    assert cache.data(body)['history_revalidation'] == {'changed': False}
    clock[0] += 1000
    seed(META, 'M5', 1000000, page(999000, 1000000, close='5'))
    result = cache.data(body)
    assert result['history_revalidation'] == {'changed': True}
    assert result['bars'][-1]['close'] == '5'
    assert result['optional_count'] == 0


def test_empty_native_snapshot_preserves_dataset_metadata(database):
    key = cache.ensure(META, 'M5')
    state = cache.snapshot(key, 1000000, 200)
    assert state['bars'] == [] and state['cache_revision'] == 0
    assert not state['history_boundary'] and not state['satisfied']
