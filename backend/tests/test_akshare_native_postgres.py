"""Native snapshot compatibility and shared acquisition in a task-owned PG.

Run only with TEST_POSTGRES_URL pointing at this task's isolated PostgreSQL.
The existing fixture creates and drops a separate schema for each test.
"""

import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
import test_akshare_native as checks
from alerts import provider_akshare, provider_cache
from alerts.akshare_native import native_metadata
from alerts.storage import now_ms
from test_provider_postgres import provider_pg as provider_pg

pytestmark = pytest.mark.skipif(
    not os.getenv('TEST_POSTGRES_URL'), reason='Requires task-owned isolated PostgreSQL')


@pytest.mark.parametrize('check', [
    checks.test_preexisting_legacy_bare_array_snapshot_is_read_without_rewrite,
    checks.test_invalid_supplier_observation_is_audited_and_survives_shared_cache,
    checks.test_provider_cache_stops_at_snapshot_edge_after_minute_refresh_deadline,
    checks.test_empty_snapshot_does_not_poison_historical_cache_and_recovers,
    checks.test_platform_variants_page_counts_descriptions_and_managed_exclusion,
])
def test_native_persistence_contracts_on_postgres(provider_pg, monkeypatch, check):
    import inspect

    args = [provider_pg[0]]
    if 'monkeypatch' in inspect.signature(check).parameters:
        args.append(monkeypatch)
    check(*args)


def test_concurrent_native_reads_share_one_selected_period_fetch(provider_pg, monkeypatch):
    started, finish = threading.Event(), threading.Event()
    calls = []

    def fetch(operation, parameters, **kwargs):
        calls.append((operation, parameters['frame']))
        started.set()
        assert finish.wait(5)
        return checks.records('2026-11-10', '2026-11-11')

    monkeypatch.setattr(provider_akshare, 'invoke', fetch)
    meta = {**native_metadata('tencent-a'), 'id': 'TENCENT-NATIVE:SZSE:000001',
            'source': 'akshare', 'symbol': 'SZSE:000001', 'precision': 4,
            'basis': 'last', 'calendar': 'source_date'}
    before = now_ms()
    provider_cache.ensure(meta, 'D1')
    with ThreadPoolExecutor(max_workers=3) as pool:
        owner = pool.submit(provider_cache.read, meta, 'D1', before, 2,
                            deadline=time.monotonic() + 10)
        assert started.wait(3)
        short = pool.submit(provider_cache.read, meta, 'D1', before, 2,
                            deadline=time.monotonic() + 0.2)
        waiter = pool.submit(provider_cache.read, meta, 'D1', before, 2,
                             deadline=time.monotonic() + 10)
        try:
            with pytest.raises(TimeoutError):
                short.result(timeout=2)
            assert not owner.done() and not waiter.done()
        finally:
            finish.set()
        first, second = owner.result(timeout=5), waiter.result(timeout=5)
    assert first['bars'] == second['bars'] and len(first['bars']) == 2
    assert calls == [('native_tencent_a', 'D1')]
    assert provider_cache.read(meta, 'D1', before, 2,
        deadline=time.monotonic() + 3)['bars'] == first['bars']
    assert len(calls) == 1
