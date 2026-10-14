"""Same public display contracts on task-isolated Ubuntu PostgreSQL."""
import os
import pytest
from test_provider_postgres import provider_pg as provider_pg
from test_chart_reload_diagnosis import (
    test_observed_m1_does_not_vanish_before_rest_confirmation as retained,
    test_exact_price_snapshot_survives_later_tick_and_confirmation as exact,
    test_older_observed_confirmation_resets_only_for_price_change as confirmed,
    test_snapshot_expiry_and_capacity_return_recoverable_codes as capacity,
    test_legacy_quote_handover_never_copies_uncertified_forming as legacy,
    test_display_replay_budget_uses_shared_background_job as background,
)
from test_fixed_indicators import test_observed_suffix_replays_all_recursive_dependencies as suffix
from test_chart_reload_matrix import test_pending_gap_pages_confirmation_and_recursive_values as matrix
pytestmark = pytest.mark.skipif(not os.getenv('TEST_POSTGRES_URL'), reason='Requires isolated Ubuntu PostgreSQL')

@pytest.mark.parametrize('transition', ['minute_rollover', 'quote_age_16s', 'reconnect'])
@pytest.mark.parametrize('cached', [False, True])
def test_retained(provider_pg, monkeypatch, transition, cached):
    retained(provider_pg[0], monkeypatch, transition, cached)

def test_exact(provider_pg, monkeypatch):
    exact(provider_pg[0], monkeypatch)


def test_capacity(provider_pg, monkeypatch):
    capacity(provider_pg[0], monkeypatch)


@pytest.mark.parametrize('valid', [False, True])
@pytest.mark.parametrize('entry', ['read', 'reconnect'])
def test_legacy(provider_pg, monkeypatch, valid, entry):
    legacy(provider_pg[0], monkeypatch, valid, entry)


@pytest.mark.parametrize('exhausted', [False, True, 'tasks', 'bytes', 'failures'])
def test_background(provider_pg, monkeypatch, exhausted):
    background(provider_pg[0], monkeypatch, exhausted)


@pytest.mark.parametrize('frame', ['M1', 'M5'])
@pytest.mark.parametrize('gap', [False, True])
def test_gap_pages(provider_pg, monkeypatch, frame, gap):
    matrix(provider_pg[0], monkeypatch, frame, gap)

@pytest.mark.parametrize('revised', [False, True])
@pytest.mark.parametrize('extremes', ['expand', 'shrink'])
def test_confirmation(provider_pg, monkeypatch, revised, extremes):
    confirmed(provider_pg[0], monkeypatch, revised, extremes)

@pytest.mark.parametrize('name', ['EMA', 'SUPERTREND_PINE_V1'])
@pytest.mark.parametrize('later_confirmed', [False, True])
def test_recursive(provider_pg, monkeypatch, name, later_confirmed):
    suffix(provider_pg[0], monkeypatch, name, later_confirmed)


def test_capture_fences_concurrent_confirmation_and_preserves_exact_old_snapshot(provider_pg, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    from alerts import live_pricing as live
    from alerts.composite_chart import chart_page
    from alerts.market_contracts import DatasetIdentity, QuoteEvent
    from alerts.storage import CompositeRevision, MarketDataset, RealtimeMapping, LiveState
    from test_composite_chart import populated
    from test_market_contracts import batch, minute
    from alerts.display_snapshots import resolve

    factory = provider_pg[0]
    composite, revision_id, seam = populated(factory, monkeypatch)
    with factory.begin() as db:
        revision = db.get(CompositeRevision, revision_id)
        target = db.get(MarketDataset, db.get(RealtimeMapping, revision.mapping_id).target_dataset_id)
        ident = DatasetIdentity.model_validate(target.identity)
    at = seam + 600010
    owner = live.claim(live.settings.oanda_account_id, now=at)
    epoch = live.begin_connection(owner, {'EUR_USD': ident}, now=at)
    live.publish_event(owner, epoch, QuoteEvent(identity=ident, bid='1.10', ask='1.11', source_time=at,
        received_at=at, tradeable=True, sequence=1, connection_epoch=epoch), {'EUR_USD': ident}, now=at)
    answer = batch(identity=ident, window_start=seam + 600000, window_end=seam + 660000,
        checkpoint=seam + 660000, observed_at=at + 1000, rows=(minute(seam + 600000,volume=None),),
        volume_kind='price_count',volume_unit='quotes')
    entered = Event()
    def confirm():
        entered.set()
        live.commit_confirmation(owner, epoch, answer, now=at + 1000)
    with ThreadPoolExecutor(max_workers=1) as pool:
        with factory.begin() as db:
            page = chart_page(db, composite, 'M1', provisional=True, now=at)
            future = pool.submit(confirm)
            assert entered.wait(2)
            # PG proves the writer is waiting for the source row's read lock,
            # rather than inferring synchronization from an arbitrary sleep.
            from sqlalchemy import text
            waiting = False
            import time
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                db.execute(text('SELECT pg_stat_clear_snapshot()'))
                waiting = bool(db.scalar(text("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'")))
                if waiting:
                    break
            assert waiting, 'confirmation writer must wait until the accepted input snapshot is copied'
            assert not future.done()
        future.result(timeout=5)
    with factory.begin() as db:
        revision = db.get(CompositeRevision,revision_id)
        snapshot=resolve(db,page['display_snapshot_id'],revision,'M1',at + 1000)
        replay=chart_page(db,composite,'M1',provisional=True,now=at + 1000,display_snapshot=snapshot)
        assert replay['bars'] == page['bars']
        current=chart_page(db,composite,'M1',provisional=True,now=at + 1000)
        assert current['input_revision'] == page['input_revision'] + 1


def test_concurrent_first_display_read_adopts_legacy_without_lock_upgrade(provider_pg, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier, local
    from alerts import live_pricing as live, display_observations, series_access
    from alerts.chart_api import DataQuery
    from alerts.market_contracts import DatasetIdentity, QuoteEvent
    from alerts.storage import CompositeRevision, MarketDataset, RealtimeMapping
    from test_composite_chart import populated
    from sqlalchemy import text

    factory = provider_pg[0]
    composite, revision_id, seam = populated(factory, monkeypatch)
    with factory.begin() as db:
        revision = db.get(CompositeRevision, revision_id)
        identity = DatasetIdentity.model_validate(db.get(MarketDataset,
            db.get(RealtimeMapping, revision.mapping_id).target_dataset_id).identity)
    at = seam + 600010
    owner = live.claim(live.settings.oanda_account_id, now=at)
    epoch = live.begin_connection(owner, {'EUR_USD': identity}, now=at)
    live.publish_event(owner, epoch, QuoteEvent(identity=identity, bid='1.10', ask='1.11',
        source_time=at, received_at=at, tradeable=True, sequence=1, connection_epoch=epoch),
        {'EUR_USD': identity}, now=at)
    monkeypatch.setattr(series_access, 'now_ms', lambda: at)
    barrier, seen = Barrier(2), local()
    original = display_observations.handover_legacy
    def handover(db, state):
        if not getattr(seen, 'entered', False):
            seen.entered = True
            barrier.wait(timeout=5)
        return original(db, state)
    monkeypatch.setattr(display_observations, 'handover_legacy', handover)
    def read():
        with factory.begin() as db:
            db.execute(text("SET LOCAL statement_timeout='4s'"))
            return series_access.chart_data(db, DataQuery(instrument=composite,
                series_kind='composite', timeframe='M1'))
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(read) for _ in range(2)]
        pages = [future.result(timeout=8) for future in futures]
    assert pages[0]['display_snapshot_id'] == pages[1]['display_snapshot_id']
    assert pages[0]['bars'] == pages[1]['bars']


def test_additive_display_migrations_roundtrip_and_preserve_observations(provider_pg, monkeypatch):
    import importlib.util
    from pathlib import Path
    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    from sqlalchemy import inspect
    modules = []
    for name in ['at47_display_observations', 'au48_display_indicator_tasks']:
        path = Path(__file__).resolve().parents[2] / ('migrations/versions/' + name + '.py')
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        modules.append(module)
    with provider_pg[1].begin() as conn:
        for module in modules:
            module.op = Operations(MigrationContext.configure(conn))
        for module in reversed(modules):
            module.downgrade()
        for module in modules:
            module.upgrade()
            module.upgrade()
        assert inspect(conn).has_table('market_observed_minutes')
        assert inspect(conn).has_table('market_display_snapshots')
        assert inspect(conn).has_table('market_display_indicator_tasks')
    retained(provider_pg[0], monkeypatch, 'minute_rollover', False)
    with provider_pg[1].begin() as conn:
        modules[0].op = Operations(MigrationContext.configure(conn))
        with pytest.raises(RuntimeError, match='backup'):
            modules[0].downgrade()
        assert inspect(conn).has_table('market_observed_minutes')


def test_terminal_task_retry(provider_pg, monkeypatch):
    from test_chart_reload_diagnosis import test_terminal_display_task_explicit_retry
    test_terminal_display_task_explicit_retry(provider_pg[0], monkeypatch)


def test_batched_terminal_task_retry(provider_pg, monkeypatch):
    from test_chart_reload_diagnosis import test_batched_terminal_display_tasks_retry_together
    test_batched_terminal_display_tasks_retry_together(provider_pg[0], monkeypatch)


def test_concurrent_terminal_retry_is_idempotent(provider_pg, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from alerts import display_indicator_jobs as jobs
    from alerts.storage import DisplayIndicatorTask, DisplaySnapshot, FixedIndicatorRun
    from test_chart_reload_diagnosis import test_display_replay_budget_uses_shared_background_job
    factory = provider_pg[0]
    test_display_replay_budget_uses_shared_background_job(factory, monkeypatch, 'failures')
    with factory.begin() as db:
        task = db.query(DisplayIndicatorTask).one()
        retry = {task.id: jobs.fault_token(task)}
        args = (task.affected, task.cursor, task.end, task.state)
        snapshot_id, run_id = task.snapshot_id, task.run_id
    def restart():
        with factory.begin() as db:
            return jobs.request(db, db.get(FixedIndicatorRun, run_id),
                db.get(DisplaySnapshot, snapshot_id), *args, retry=retry)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: restart(), range(2)))
    assert all(result['pending'] for result in results)
    with factory.begin() as db:
        task = db.query(DisplayIndicatorTask).one()
        assert task.status == 'pending' and task.error is None and task.lease_token is None


def test_mixed_stale_retry_rollback(provider_pg, monkeypatch):
    from test_chart_reload_diagnosis import test_mixed_stale_display_retry_survives_transaction_rollback
    test_mixed_stale_display_retry_survives_transaction_rollback(provider_pg[0], monkeypatch)
