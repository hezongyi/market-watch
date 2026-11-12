"""Real queue and quote entries avoid repeated work without skipping commits."""
import pytest
from alerts import provider_service
from alerts.storage import ProviderDataset, now_ms
from sqlalchemy import event, select
from test_live_pricing import running as running


def test_generic_worker_does_not_listen_to_composite_publications(monkeypatch):
    from alerts import chart_aggregation_worker, publication_wakeup, runtime_health
    from test_idle_worker_costs import Stop, Wake

    selected = []
    def listener(**kwargs):
        selected.append(kwargs.get('channel', publication_wakeup.CHANNEL))
        return Wake()
    monkeypatch.setattr(publication_wakeup, 'PublicationWakeup', listener)
    monkeypatch.setattr(runtime_health, 'progress', lambda **kwargs: None)
    monkeypatch.setattr(chart_aggregation_worker, 'cycle', lambda: (False, False))
    chart_aggregation_worker.run(Stop(2))
    assert selected == ['market_watch_derivation_work']


def test_unchanged_provider_capacity_reuses_committed_revision(database):
    from test_provider_cache import META, page, seed

    key = seed(META, 'M5', 10000, page(1000, 10000))
    with database.begin() as db:
        db.get(ProviderDataset, key).accessed_at = now_ms() - 3600000
    statements, cache = [], {}
    engine = database.kw['bind']

    def record(conn, cursor, statement, *args):
        if 'count(' in statement.lower() and 'provider_bars' in statement:
            statements.append(statement)

    event.listen(engine, 'before_cursor_execute', record)
    try:
        provider_service.cleanup(capacity_cache=cache)
        provider_service.cleanup(capacity_cache=cache)
    finally:
        event.remove(engine, 'before_cursor_execute', record)
    assert len(statements) == 1


def test_capacity_recounts_committed_writes_limit_and_hour_but_not_rollback(database, monkeypatch):
    from alerts import provider_cache
    from alerts.config import settings
    from test_provider_cache import META, page, seed

    clock = [0]
    monkeypatch.setattr(provider_service.time, 'monotonic', lambda: clock[0])
    key = seed(META, 'M5', 10000, page(1000, 10000))
    def age():
        with database.begin() as db:
            db.get(ProviderDataset, key).accessed_at = now_ms() - 3600000
    age()
    calls, cache = [], {}
    engine = database.kw['bind']
    def record(conn, cursor, statement, *args):
        if 'count(' in statement.lower() and 'provider_bars' in statement:
            calls.append(statement)
    event.listen(engine, 'before_cursor_execute', record)
    try:
        provider_service.cleanup(capacity_cache=cache)
        lease = provider_cache.claim(key)
        invalid = {**page(10000, 11000), 'coverage': [[0, 12000]]}
        with pytest.raises(ValueError):
            provider_cache.commit_page(key, lease, invalid, 11000, now_ms())
        provider_cache.release(key, lease)
        provider_service.cleanup(capacity_cache=cache)
        assert len(calls) == 1
        seed(META, 'M5', 11000, page(10000, 11000))
        age()
        provider_service.cleanup(capacity_cache=cache)
        assert len(calls) == 2
        monkeypatch.setattr(settings, 'provider_cache_max_bars', settings.provider_cache_max_bars+1)
        provider_service.cleanup(capacity_cache=cache)
        assert len(calls) == 3
        clock[0] = 3600
        provider_service.cleanup(capacity_cache=cache)
        assert len(calls) == 4
    finally:
        event.remove(engine, 'before_cursor_execute', record)


def test_failed_cleanup_never_acknowledges_count_and_expiry_still_runs(database):
    from alerts.config import settings
    from test_provider_cache import META, page, seed

    key = seed(META, 'M5', 10000, page(1000, 10000))
    with database.begin() as db:
        db.get(ProviderDataset, key).accessed_at = now_ms() - 3600000
    engine, cache, counted = database.kw['bind'], {}, []
    def record(conn, cursor, statement, *args):
        if 'count(' in statement.lower() and 'provider_bars' in statement:
            counted.append(True)
    def fail_commit(conn):
        if counted:
            raise ValueError('commit failed')
    event.listen(engine, 'before_cursor_execute', record)
    event.listen(engine, 'commit', fail_commit)
    try:
        with pytest.raises(ValueError, match='commit failed'):
            provider_service.cleanup(capacity_cache=cache)
    finally:
        event.remove(engine, 'commit', fail_commit)
        event.remove(engine, 'before_cursor_execute', record)
    assert counted and not cache
    provider_service.cleanup(capacity_cache=cache)
    assert cache
    with database.begin() as db:
        db.get(ProviderDataset, key).accessed_at = now_ms() - (settings.provider_cache_days+1)*86400000
    provider_service.cleanup(check_capacity=False, capacity_cache=cache)
    with database() as db:
        assert db.get(ProviderDataset, key) is None


def test_overquota_bounded_eviction_is_not_cached_as_complete(database, monkeypatch):
    from alerts.config import settings
    from alerts.storage import ProviderBar
    from test_provider_cache import META, page, seed

    monkeypatch.setattr(settings, 'provider_cache_max_bars', 1)
    keys = [seed({**META, 'symbol': f'CAPACITY_{i}'}, 'M5', 3000, page(1000, 3000))
            for i in range(22)]
    with database.begin() as db:
        for key in keys:
            db.get(ProviderDataset, key).accessed_at = now_ms() - 3600000
    cache = {}
    provider_service.cleanup(capacity_cache=cache)
    assert not cache, 'The 20-dataset bound left quota work for the next round'
    with database() as db:
        assert len(list(db.scalars(select(ProviderDataset)))) == 2
    provider_service.cleanup(capacity_cache=cache)
    with database() as db:
        assert db.scalar(select(ProviderBar)) is None


def test_quote_reuses_dataset_parent_lock_query(running):
    from alerts import live_pricing as live
    from alerts.storage import LiveMinute, LiveState
    from test_live_pricing import quote

    factory, ownership, epoch, identities = running
    engine = factory.kw['bind']
    identity = identities['EUR_USD']
    completed = set()
    live.publish_event(ownership, epoch, quote(identity, epoch), identities,
                       now=125000, completed_handovers=completed)
    live.publish_event(ownership, epoch, quote(identity, epoch, seq=2, source=121001),
                       identities, now=125000, completed_handovers=completed)
    reads, state_updates = [], []

    def record(conn, cursor, statement, *args):
        if statement.startswith('SELECT') and 'FROM market_datasets' in statement:
            reads.append(statement)
        if statement.startswith('UPDATE market_live_states'):
            state_updates.append(statement)

    event.listen(engine, 'before_cursor_execute', record)
    try:
        for seq in (3, 4):
            assert live.publish_event(ownership, epoch,
                quote(identity, epoch, seq=seq, source=121000+seq, bid=str(1+seq/10)),
                identities, now=125000, completed_handovers=completed) == 'accepted'
    finally:
        event.remove(engine, 'before_cursor_execute', record)
    assert len(reads) == 2, reads
    assert len(state_updates) == 2, 'Each complete quote snapshot needs only one state UPDATE'
    with factory() as db:
        assert db.get(LiveState, identity.key).quote['sequence'] == 4
        assert db.scalar(select(LiveMinute).where(LiveMinute.dataset_id == identity.key)).quote_count == 4
