import os

import pytest
from alerts import provider_cache as cache
from alerts import provider_chart as upstream
from test_native_reserve import reserve
from test_provider_cache import META, page, seed
from test_provider_postgres import provider_pg as provider_pg

pytestmark = pytest.mark.skipif(not os.getenv('TEST_POSTGRES_URL'),
                               reason='Requires isolated PostgreSQL')


def test_nonfocused_reserve_read_uses_coherent_pg_snapshot(provider_pg, monkeypatch):
    seed(META, 'M5', 1000000, page(0, 1000000, boundary=True))
    monkeypatch.setattr(upstream, 'metadata', lambda _: META)
    monkeypatch.setattr(upstream, 'native_page', lambda *a, **k: pytest.fail('reserve fetched upstream'))
    result = cache.data(reserve())
    assert result['cache_hit'] and len(result['bars']) == 131
    assert result['cache_revision'] >= 1 and result['as_of'] > 0
    assert result['reserve_status'] == 'ready' and result['mandatory_count'] == 0
    assert result['candles_http_attempts'] == []


def test_reserve_miss_never_waits_for_dataset_activation_lock(provider_pg, monkeypatch):
    import time
    from concurrent.futures import ThreadPoolExecutor

    from alerts.storage import ProviderDataset
    from sqlalchemy import select

    factory, _ = provider_pg
    key = seed(META, 'M5', 1000000, page(980000, 1000000))
    monkeypatch.setattr(upstream, 'metadata', lambda _: META)
    monkeypatch.setattr(upstream, 'native_page', lambda *a, **k: pytest.fail('miss fetched upstream'))
    def read():
        token = cache.DEADLINE.set(time.monotonic() + .3)
        try:
            return cache.data(reserve(client='reserve-locked'))
        finally:
            cache.DEADLINE.reset(token)
    with ThreadPoolExecutor(max_workers=1) as pool:
        with factory.begin() as writer:
            writer.scalar(select(ProviderDataset).where(ProviderDataset.id == key).with_for_update())
            pending = pool.submit(read)
            try:
                result = pending.result(timeout=.8)
            finally:
                writer.rollback()
    assert len(result['bars']) == 20 and result['reserve_status'] == 'partial'
    assert not result['history_boundary']
