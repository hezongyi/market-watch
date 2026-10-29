"""Ubuntu isolated PostgreSQL period publication, leases and migration."""

import importlib.util
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
import test_composite_aggregates as contracts
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alerts import composite_aggregates as cache
from alerts.storage import CompositeAggregateBar, CompositeAggregateTask
from sqlalchemy import inspect, select
from test_composite_chart import populated
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated Ubuntu PostgreSQL")


@pytest.mark.parametrize("contract", [
    contracts.test_persisted_pages_match_stitched_inputs_and_skip_m1_reads,
    contracts.test_accepted_correction_invalidates_only_affected_buckets_and_old_inputs_remain,
    contracts.test_expired_owner_cannot_publish_after_successor_and_next_event_arrival_is_preserved,
    contracts.test_partial_event_checkpoint_does_not_publish_stale_page,
    contracts.test_sparse_long_tail_and_exclusive_pages_use_persisted_buckets,
    contracts.test_bucket_time_closure_updates_without_new_input_and_pending_seam_is_retained,
    contracts.test_failed_build_keeps_checkpoint_and_retry_recovers,
    contracts.test_materialized_page_overlays_only_valid_provisional_stream_and_never_persists_it,
])
def test_period_contract(provider_pg, monkeypatch, contract):
    contract(provider_pg[0], monkeypatch)


def test_concurrent_claims_have_one_owner_and_duplicate_commit_is_rejected(provider_pg, monkeypatch):
    factory, _ = provider_pg
    _, revision, _ = populated(factory, monkeypatch)
    with ThreadPoolExecutor(max_workers=2) as pool:
        owned = list(pool.map(lambda _: cache.claim(revision, "M1"), range(2)))
    selected = [claim for claim in owned if claim]
    assert len(selected) == 1
    bars = cache.build(selected[0])
    cache.commit(selected[0], bars)
    with pytest.raises(TimeoutError):
        cache.commit(selected[0], bars)


def test_additive_migration_preserves_existing_inputs_and_rejects_snapshot_loss(provider_pg, monkeypatch):
    factory, engine = provider_pg
    _, revision, _ = populated(factory, monkeypatch)
    path = Path(__file__).resolve().parents[2] / "migrations/versions/ag34_composite_aggregates.py"
    spec = importlib.util.spec_from_file_location("composite_aggregate_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    with engine.begin() as conn:
        CompositeAggregateBar.__table__.drop(conn)
        CompositeAggregateTask.__table__.drop(conn)
        migration.op = Operations(MigrationContext.configure(conn))
        migration.upgrade()
        assert "market_composite_aggregate_bars" in inspect(conn).get_table_names()
    contracts.drain(revision, "M1")
    with factory.begin() as db:
        assert db.scalar(select(CompositeAggregateBar))
    with engine.begin() as conn:
        migration.op = Operations(MigrationContext.configure(conn))
        with pytest.raises(RuntimeError, match="backup"):
            migration.downgrade()


def test_only_completed_waterline_commit_delivers_notification(provider_pg, monkeypatch):
    from alerts.publication_wakeup import PublicationWakeup
    from alerts.storage import CompositeInputEvent

    factory, engine = provider_pg
    _, revision, _ = populated(factory, monkeypatch)
    contracts.drain(revision, 'M1')
    with factory() as db:
        latest = max(m['start'] for e in db.scalars(select(CompositeInputEvent).where(
            CompositeInputEvent.revision_id == revision)) for m in e.input_manifest['minutes'])
    contracts.two_minute_input(factory, revision, latest + 60000, 200002000)
    monkeypatch.setattr(cache, 'MAX_BUCKETS', 1)
    with PublicationWakeup(engine) as wake:
        assert wake.connection is not None
        first = cache.claim(revision, 'M1')
        assert first['total'] == 2
        cache.commit(first, cache.build(first))
        assert wake.wait(.05) == 'timer'
        contracts.drain(revision, 'M1')
        assert wake.wait(2) == 'notification'
