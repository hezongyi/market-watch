"""Real lock ownership, input generations and atomic publication retries."""

import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest
import test_coverage_projection as projection_contracts
from alerts import managed_dataset as managed
from alerts import market, storage
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from test_publication_scheduler import MINUTE, START

pytestmark = pytest.mark.skipif(not os.getenv('TEST_POSTGRES_URL'), reason='Requires isolated Ubuntu PostgreSQL')


def test_pg_service_order_survives_different_history_and_clock_rollback(publication_pg, monkeypatch):
    from test_publication_scheduler import (
        test_service_order_survives_different_history_and_clock_rollback,
    )
    test_service_order_survives_different_history_and_clock_rollback(publication_pg[0], monkeypatch)


def test_pg_failed_target_does_not_idle_other_ready_targets(publication_pg, monkeypatch):
    from test_publication_scheduler import test_failed_target_does_not_idle_other_ready_targets
    test_failed_target_does_not_idle_other_ready_targets(publication_pg[0], monkeypatch)


@pytest.fixture
def publication_pg(monkeypatch):
    url = os.environ['TEST_POSTGRES_URL']
    schema = 'publication_' + uuid.uuid4().hex
    admin = create_engine(url, pool_size=1, max_overflow=0)
    with admin.begin() as conn:
        conn.execute(text(f'CREATE SCHEMA {schema}'))
    engine = create_engine(url, connect_args={'options': f'-csearch_path={schema}'},
                           pool_size=4, max_overflow=0)
    storage.bootstrap(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(storage, 'Session', factory)
    clock = [START + 30 * MINUTE + 5000]
    monkeypatch.setattr(managed, 'now_ms', lambda: clock[0])
    monkeypatch.setattr(storage, 'now_ms', lambda: clock[0])
    try:
        yield factory, clock
    finally:
        engine.dispose()
        with admin.begin() as conn:
            conn.execute(text(f'DROP SCHEMA {schema} CASCADE'))
        admin.dispose()


def seed(factory, clock, identities=('BTCUSDT',)):
    with factory.begin() as db:
        for ident in identities:
            inst = db.get(storage.Instrument, ident)
            managed.join(db, inst, START, clock[0])
            market.ingest(db, inst, {'coverage': [dict(start=START, end=clock[0] - 5000)], 'rows': [
                dict(timestamp=START + i * MINUTE, open=10, high=11, low=9, close=10)
                for i in range(30)]}, received_at=clock[0])
    drain()


def drain():
    for _ in range(100):
        if not managed.publish_once():
            return
    pytest.fail('Bounded publication requests failed to drain')


def observe(factory, clock, ident='BTCUSDT'):
    with factory.begin() as db:
        market.ingest(db, db.get(storage.Instrument, ident), {'rows': [
            dict(timestamp=START + 29 * MINUTE, open=10, high=11, low=9, close=10)]},
            received_at=clock[0])


def visible(factory, clock, ident='BTCUSDT'):
    with factory.begin() as db:
        return managed.read_rows(db, db.get(storage.Instrument, ident), 'M1', clock[0], 1)[0]['observed_at']


def test_new_generation_created_after_copy_in_same_transaction_is_not_acknowledged(publication_pg, monkeypatch):
    factory, clock = publication_pg
    seed(factory, clock)
    clock[0] += 1000
    observe(factory, clock)
    original = managed.publish_frame
    later = clock[0] + 1000
    def publish(db, inst, plan, frame, stamp):
        result = original(db, inst, plan, frame, stamp)
        market.ingest(db, inst, {'rows': [dict(timestamp=START + 29 * MINUTE,
            open=10, high=11, low=9, close=10)]}, received_at=later)
        return result
    monkeypatch.setattr(managed, 'publish_frame', publish)
    assert managed.publish_once()
    assert visible(factory, clock) < later
    monkeypatch.setattr(managed, 'publish_frame', original)
    clock[0] = later
    drain()  # independent sessions, as after a worker restart
    assert visible(factory, clock) == later


def test_input_writer_after_publisher_lock_keeps_its_new_generation(publication_pg, monkeypatch):
    factory, clock = publication_pg
    seed(factory, clock)
    clock[0] += 1000
    observe(factory, clock)
    entered, release, writing, committed = Event(), Event(), Event(), Event()
    original = managed.publish_frame
    def publish(*args):
        entered.set()
        assert release.wait(10)
        return original(*args)
    def writer():
        writing.set()
        observe(factory, clock)
        committed.set()
    monkeypatch.setattr(managed, 'publish_frame', publish)
    with ThreadPoolExecutor(max_workers=2) as pool:
        publishing = pool.submit(managed.publish_once)
        try:
            assert entered.wait(10)
            clock[0] += 1000
            pending = pool.submit(writer)
            assert writing.wait(10)
            assert not committed.wait(.1), 'Writer must serialize with the publication identity lock'
        finally:
            release.set()
        assert publishing.result(timeout=10)
        pending.result(timeout=10)
    monkeypatch.setattr(managed, 'publish_frame', original)
    drain()
    assert visible(factory, clock) == clock[0]


def test_failed_copy_rolls_back_visible_data_then_retries_durable_input(publication_pg, monkeypatch):
    factory, clock = publication_pg
    seed(factory, clock)
    before = visible(factory, clock)
    clock[0] += 1000
    observe(factory, clock)
    original = managed.publish_frame
    def fail(*args):
        original(*args)
        args[0].flush()
        raise RuntimeError('Injected post-copy transaction failure')
    monkeypatch.setattr(managed, 'publish_frame', fail)
    result = managed.publish_once()
    assert not result.snapshot_changed and not result.task_progressed
    assert result.attempted and result.blocked_reason == 'RuntimeError'
    assert visible(factory, clock) == before
    monkeypatch.setattr(managed, 'publish_frame', original)
    clock[0] += 2000
    drain()
    assert visible(factory, clock) == before + 1000


def test_locked_identity_does_not_hold_up_another_ready_identity(publication_pg):
    factory, clock = publication_pg
    seed(factory, clock, ('BTCUSDT', 'EURUSD'))
    clock[0] += 1000
    observe(factory, clock, 'BTCUSDT')
    observe(factory, clock, 'EURUSD')
    with factory.begin() as db:
        db.execute(text("SELECT id FROM instruments WHERE id='BTCUSDT' FOR UPDATE"))
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(managed.publish_once)
            try:
                assert future.result(timeout=2)
                assert visible(factory, clock, 'EURUSD') == clock[0]
            finally:
                db.commit()


@pytest.mark.parametrize('contract', [
    projection_contracts.test_projection_keeps_legacy_margin_and_unknown_gap_without_audit_reads,
    projection_contracts.test_wrong_source_and_malformed_legacy_proofs_never_certify_coverage,
    projection_contracts.test_checkpoint_catches_late_uuid_behind_cursor_and_proof_removal,
    projection_contracts.test_publisher_pages_never_run_full_raw_proof_verification,
])
def test_postgres_coverage_contract(publication_pg, contract):
    contract(publication_pg[0])


def test_postgres_projection_dual_write_and_compatibility_return(publication_pg, monkeypatch):
    projection_contracts.test_completed_projection_dual_writes_new_proof_and_can_return_to_compatibility(
        publication_pg[0], monkeypatch)


def test_postgres_explicit_proof_removal_retracts_published_aggregate(publication_pg, monkeypatch):
    projection_contracts.test_explicit_proof_removal_retracts_sparse_published_hour(
        publication_pg[0], monkeypatch)


def test_postgres_restart_catches_up_without_new_input(publication_pg, monkeypatch):
    from test_publication_scheduler import (
        test_restart_catches_up_more_than_one_source_page_without_further_input,
    )
    test_restart_catches_up_more_than_one_source_page_without_further_input(publication_pg[0], monkeypatch)


def test_postgres_aggregation_backfill_service_with_continuous_live_work(publication_pg, monkeypatch):
    from test_chart_aggregation import (
        test_old_backfill_gets_service_during_continuous_focused_live_work,
    )
    test_old_backfill_gets_service_during_continuous_focused_live_work(publication_pg[0], monkeypatch)


def test_postgres_unavailable_older_bucket_waits_for_input(publication_pg, monkeypatch):
    from test_publication_scheduler import (
        test_incomplete_older_source_bucket_does_not_keep_publication_runnable,
    )
    test_incomplete_older_source_bucket_does_not_keep_publication_runnable(publication_pg[0], monkeypatch)


def test_postgres_fixed_clock_preserves_ready_target_fairness(publication_pg, monkeypatch):
    from test_publication_scheduler import (
        test_fixed_clock_continuously_runnable_target_does_not_starve_other_ready_targets,
    )
    test_fixed_clock_continuously_runnable_target_does_not_starve_other_ready_targets(publication_pg[0], monkeypatch)
