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
