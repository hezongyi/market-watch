"""Real PostgreSQL lease/rollback/migration checks, only in a unique test schema."""

import importlib.util
import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alerts import provider_cache as cache
from alerts import provider_chart as upstream
from alerts import storage
from alerts.storage import ProviderBar, ProviderDataset
from sqlalchemy import create_engine, func, inspect, select, text
from sqlalchemy.orm import sessionmaker
from test_provider_cache import META, page

pytestmark = pytest.mark.skipif(
    not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated PostgreSQL"
)


@pytest.fixture
def provider_pg(monkeypatch):
    url = os.environ["TEST_POSTGRES_URL"]
    admin = create_engine(url, pool_size=1, max_overflow=0)
    schema = "provider_" + uuid.uuid4().hex
    with admin.begin() as conn:
        conn.execute(text(f"CREATE SCHEMA {schema}"))
    isolated = create_engine(
        url, connect_args={"options": f"-csearch_path={schema}"}, pool_size=2, max_overflow=0
    )
    storage.Base.metadata.create_all(isolated)
    factory = sessionmaker(isolated, expire_on_commit=False)
    monkeypatch.setattr(storage, "Session", factory)
    try:
        yield factory, isolated
    finally:
        isolated.dispose()
        with admin.begin() as conn:
            conn.execute(text(f"DROP SCHEMA {schema} CASCADE"))
        admin.dispose()


def test_shared_waiters_have_independent_deadlines_and_only_one_upstream_fetch(
    provider_pg, monkeypatch
):
    started, finish = threading.Event(), threading.Event()
    calls = []

    def fetch(meta, frame, before, count, **kwargs):
        calls.append(count)
        started.set()
        assert finish.wait(3)
        return page(before - count * 1000, before)

    monkeypatch.setattr(upstream, "native_page", fetch)
    cache.ensure(META, "M5")
    with ThreadPoolExecutor(max_workers=3) as pool:
        owner = pool.submit(cache.read, META, "M5", 1000000, 200, deadline=time.monotonic() + 4)
        assert started.wait(2)
        short = pool.submit(cache.read, META, "M5", 1000000, 80, deadline=time.monotonic() + 0.15)
        survivor = pool.submit(cache.read, META, "M5", 1000000, 100, deadline=time.monotonic() + 4)
        try:
            with pytest.raises(TimeoutError):
                short.result(timeout=2)
            assert not owner.done() and not survivor.done()
        finally:
            finish.set()
        assert len(owner.result(timeout=2)["bars"]) == 200
        assert len(survivor.result(timeout=2)["bars"]) == 100
    assert calls == [200], "a timed-out waiter cannot cancel or duplicate shared acquisition"


def test_claim_fences_competing_owners_and_rollback_is_atomic(provider_pg):
    factory, _ = provider_pg
    key = cache.ensure(META, "M5")
    with ThreadPoolExecutor(max_workers=4) as pool:
        claims = list(pool.map(lambda _: cache.claim(key), range(4)))
    leases = [x for x in claims if x is not None]
    assert len(leases) == 1
    old = leases[0]
    with factory.begin() as db:
        db.get(ProviderDataset, key).lease_until = 0
    successor = cache.claim(key)
    with pytest.raises(TimeoutError):
        cache.commit_page(key, old, page(1000, 2000), 2000, cache.now_ms())
    invalid = {**page(1000, 2000), "coverage": [[0, 3000]]}
    with pytest.raises(ValueError):
        cache.commit_page(key, successor, invalid, 2000, cache.now_ms())
    with factory.begin() as db:
        assert db.scalar(select(func.count()).select_from(ProviderBar)) == 0
        assert db.get(ProviderDataset, key).coverage == []
    cache.release(key, old)
    with factory.begin() as db:
        assert db.get(ProviderDataset, key).lease_token == successor[0]
    cache.commit_page(key, successor, page(1000, 2000), 2000, cache.now_ms())
    cache.release(key, successor)


def test_bulk_4000_commit_range_and_migration_roundtrip(provider_pg):
    factory, engine = provider_pg
    key = cache.ensure(META, "M5")
    lease = cache.claim(key)
    cache.commit_page(key, lease, page(0, 4000000, boundary=True), 4000000, cache.now_ms())
    cache.release(key, lease)
    assert len(cache.snapshot(key, 4000000, 4000)["bars"]) == 4000
    with factory.begin() as db:
        assert db.scalar(select(func.count()).select_from(ProviderBar)) == 4000
    path = Path(__file__).resolve().parents[2] / "migrations/versions/m14_provider_cache.py"
    spec = importlib.util.spec_from_file_location("provider_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    # The isolated schema contains no managed data in provider tables. Drop only
    # these new tables to test the exact migration, leaving unrelated tables intact.
    with engine.begin() as conn:
        migration.op = Operations(MigrationContext.configure(conn))
        migration.downgrade()
        assert inspect(conn).has_table("candles")
        for _ in range(2):
            migration.upgrade()
            assert inspect(conn).has_table("provider_interests")
            assert "indicators" in {
                c["name"] for c in inspect(conn).get_columns("provider_interests")
            }
            migration.downgrade()
        migration.upgrade()


def test_revision_migration_backfills_existing_observations_and_preserves_bars(provider_pg):
    factory, engine = provider_pg
    key = cache.ensure(META, "M5")
    lease = cache.claim(key)
    cache.commit_page(key, lease, page(1000, 4000), 4000, 123456)
    cache.release(key, lease)
    path = Path(__file__).resolve().parents[2] / "migrations/versions/n15_provider_revisions.py"
    spec = importlib.util.spec_from_file_location("revision_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    before = cache.snapshot(key, 4000, 3)["bars"]
    with engine.begin() as conn:
        migration.op = Operations(MigrationContext.configure(conn))
        migration.downgrade()
        assert "changed_at" not in {c["name"] for c in inspect(conn).get_columns("provider_bars")}
        migration.upgrade()
    with factory.begin() as db:
        bars = list(db.scalars(select(ProviderBar).where(ProviderBar.dataset_id == key)))
        assert len(bars) == 3 and all(bar.changed_at == 123456 for bar in bars)
    assert cache.snapshot(key, 4000, 3)["bars"] == before


def test_history_response_is_one_statement_snapshot_during_revision(provider_pg, monkeypatch):
    from sqlalchemy import event
    from test_provider_cache import seed
    _, engine = provider_pg
    clock = [100000]
    monkeypatch.setattr(cache, 'now_ms', lambda: clock[0])
    key = seed(META, 'M5', 10000, page(1000, 10000))
    read_done, revision_done = threading.Event(), threading.Event()
    selects = []
    reader_ident = []
    def pause_after_select(conn, cursor, statement, params, context, many):
        if threading.get_ident() not in reader_ident or not statement.lstrip().upper().startswith('SELECT'):
            return
        selects.append(statement)
        if 'LEFT OUTER JOIN' in statement and 'provider_datasets' in statement:
            read_done.set()
            assert revision_done.wait(4)
    event.listen(engine, 'after_cursor_execute', pause_after_select)
    def reader():
        reader_ident.append(threading.get_ident())
        return cache.snapshot(key, 10000, 5)
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(reader)
            assert read_done.wait(3)
            clock[0] = 101000
            seed(META, 'M5', 6000, page(5000, 6000, close='5'))
            revision_done.set()
            original = pending.result(timeout=3)
        assert len(selects) == 1, 'metadata and bars must share one statement, not default transaction isolation'
        assert original['as_of'] == 100000 and original['cache_revision'] == 1
        # The changed bar is in the response window; pairing old bars with a
        # new metadata version would incorrectly suppress the subscription reset.
        assert original['bars'][0]['close'] == '2'
        current = cache.snapshot(key, 10000, 6)
        assert current['as_of'] == 101000 and current['cache_revision'] == 2
        assert current['bars'][1]['close'] == '5'
        empty = cache.ensure({**META, 'symbol': 'EMPTY_SNAPSHOT'}, 'M5')
        assert cache.snapshot(empty, 10000, 5)['bars'] == []
    finally:
        revision_done.set()
        event.remove(engine, 'after_cursor_execute', pause_after_select)


@pytest.mark.parametrize('replace', [False, True])
def test_old_warmer_cannot_overwrite_expanded_or_recreated_task(provider_pg, monkeypatch, replace):
    from alerts import provider_service as service
    from alerts.storage import ProviderInterest
    from test_provider_cache import seed
    factory, _ = provider_pg
    monkeypatch.setattr(service.settings, 'provider_basic_bars', 3)
    monkeypatch.setattr(service.settings, 'provider_depth_bars', 8)
    key = seed(META, 'M5', 100000, page(99000, 100000))
    service.activate('race', key, 100000, 3, latest=True)
    ident = service.interest_id('race', 'read:' + key + ':latest')
    started, finish = threading.Event(), threading.Event()
    def fetch(meta, frame, before, count, **kwargs):
        started.set()
        assert finish.wait(4)
        return page(before - count * 1000, before)
    monkeypatch.setattr(upstream, 'native_page', fetch)
    with factory.begin() as db:
        original_task = db.get(ProviderInterest, ident).targets[0]['task_id']
    with ThreadPoolExecutor(max_workers=1) as pool:
        worker = pool.submit(service.warm_step, 'oanda')
        assert started.wait(3)
        if replace:
            service.unsubscribe('race', 'read:' + key + ':latest')
        service.activate('race', key, 100000, 10, latest=True)
        finish.set()
        worker.result(timeout=3)
    with factory.begin() as db:
        target = db.get(ProviderInterest, ident).targets[0]
        assert target['count'] == 10 and not target['done']
        assert (target['task_id'] != original_task) == replace
        assert target['generation'] == (0 if replace else 1)
        assert db.scalar(select(func.count()).select_from(ProviderBar)) == 3, 'successful old worker page remains useful'


def test_concurrent_activation_merges_max_and_reopens_completed_goals(provider_pg, monkeypatch):
    from alerts import provider_service as service
    from alerts.storage import ProviderInterest
    from test_provider_cache import seed
    factory, _ = provider_pg
    monkeypatch.setattr(service.settings, 'provider_basic_bars', 3)
    monkeypatch.setattr(service.settings, 'provider_depth_bars', 8)
    key = seed(META, 'M5', 100000, page(95000, 100000))
    service.activate('race', key, 100000, 3, latest=True)
    service.warm_step('oanda')
    ident = service.interest_id('race', 'read:' + key + ':latest')
    with factory.begin() as db:
        assert db.get(ProviderInterest, ident).targets[0]['done']
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda n: service.activate('race', key, 110000, n, latest=True), [12, 10]))
    with factory.begin() as db:
        targets = db.get(ProviderInterest, ident).targets
        assert targets[0]['before'] == 100000, 'latest anchor stays fixed'
        assert targets[0]['count'] == targets[9]['count'] == 12
        assert not targets[0]['done']
        assert all(t['generation'] == 0 for t in targets if t['frame'] != 'M5')


def test_snapshot_housekeeping_skips_a_locked_dataset(provider_pg):
    from test_provider_cache import seed
    factory, _ = provider_pg
    key = seed(META, 'M5', 10000, page(1000, 10000))
    with factory.begin() as writer:
        writer.scalar(select(ProviderDataset).where(ProviderDataset.id == key).with_for_update())
        token = cache.DEADLINE.set(time.monotonic() + 0.5)
        try:
            started = time.monotonic()
            state = cache.snapshot(key, 10000, 5)
            assert len(state['bars']) == 5
            assert time.monotonic() - started < 0.5, 'accessed_at cannot block coherent delivery'
        finally:
            cache.DEADLINE.reset(token)


def test_expired_pool_waiter_executes_no_provider_statement(provider_pg):
    from sqlalchemy import event
    from test_provider_cache import seed
    factory, engine = provider_pg
    key = seed(META, 'M5', 10000, page(1000, 10000))
    held = [engine.connect(), engine.connect()]
    started = threading.Event()
    statements = []
    def observed(conn, cursor, statement, params, context, many):
        statements.append(statement)
    event.listen(engine, 'before_cursor_execute', observed)
    def waiter():
        token = cache.DEADLINE.set(time.monotonic() + 0.1)
        try:
            started.set()
            return cache.snapshot(key, 10000, 5)
        finally:
            cache.DEADLINE.reset(token)
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(waiter)
            assert started.wait(1)
            time.sleep(0.2)
            held.pop().close()
            with pytest.raises(TimeoutError):
                pending.result(timeout=2)
        assert statements == [], 'expired acquisition must release without provider SQL'
    finally:
        for connection in held:
            connection.close()
        event.remove(engine, 'before_cursor_execute', observed)
