"""Actual PostgreSQL minute serialization, immutable inputs and catch-up leases."""

import importlib.util
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
import test_composite_preparation as preparation
import test_confirmed_minutes as contracts
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alerts.confirmed_minutes import record
from alerts.storage import (
    CompositeInputEvent,
    CompositeMinute,
    CompositeMinuteInput,
    CompositeReadAttempt,
    SourceMinute,
    SourceMinuteRevision,
)
from sqlalchemy import func, inspect, select
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated Ubuntu PostgreSQL")


@pytest.mark.parametrize("contract", [
    contracts.test_unchanged_newer_observation_prevents_late_price_rollback,
    contracts.test_calendar_variants_share_heads_but_sources_do_not,
])
def test_postgres_minute_contract(provider_pg, contract):
    contract(provider_pg[0])


@pytest.mark.parametrize("contract", [
    contracts.test_composite_logs_changed_inputs_and_keeps_previous_price_evidence,
    preparation.test_fixed_tail_checkpoint_and_minute_input_are_independent,
    preparation.test_empty_success_finishes_query_without_confirming_any_prices,
    preparation.test_lease_replacement_rejects_old_source_writes_and_preserves_interruption,
    preparation.test_failed_reads_retry_without_losing_the_failure_denominator,
    preparation.test_source_cache_can_prepare_another_revision_without_fabricating_live_read,
])
def test_postgres_composite_input_contract(provider_pg, monkeypatch, contract):
    contract(provider_pg[0], monkeypatch)


def test_concurrent_confirmations_share_one_head_and_newest_watermark(provider_pg):
    factory, _ = provider_pg
    def confirm(stamp):
        with factory.begin() as db:
            return record(db, contracts.observation(stamp))
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(confirm, [100, 200, 150, 300, 250, 350, 400, 50]))
    assert len({result["minutes"][0]["revision_id"] for result in results}) == 1
    with factory.begin() as db:
        assert db.scalar(select(func.count()).select_from(SourceMinuteRevision)) == 2
        assert db.get(SourceMinute, (results[0]["source_id"], 0)).last_observed_at == 400


def test_additive_migration_and_audit_downgrade_guard(provider_pg):
    factory, engine = provider_pg
    path = Path(__file__).resolve().parents[2] / "migrations/versions/af33_composite_inputs.py"
    spec = importlib.util.spec_from_file_location("confirmed_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    with engine.begin() as conn:
        for model in (CompositeMinute, CompositeMinuteInput, CompositeInputEvent, CompositeReadAttempt,
                      SourceMinute, SourceMinuteRevision):
            model.__table__.drop(conn)
        migration.op = Operations(MigrationContext.configure(conn))
        migration.upgrade()
        assert "last_observed_at" in {col["name"] for col in inspect(conn).get_columns("market_source_minutes")}
    with factory.begin() as db:
        record(db, contracts.observation(100))
    with engine.begin() as conn:
        migration.op = Operations(MigrationContext.configure(conn))
        with pytest.raises(RuntimeError, match="backup"):
            migration.downgrade()
