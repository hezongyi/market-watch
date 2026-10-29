"""Switch runs keep the same contract on PostgreSQL, including the migration."""

import importlib.util
import os
from pathlib import Path

import pytest
import test_switch_runs as contracts
from alembic.migration import MigrationContext
from alembic.operations import Operations
from postgres_migration_helpers import complete, predecessor
from sqlalchemy import inspect
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(
    not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated Ubuntu PostgreSQL"
)

COLUMNS = {
    "id", "kind", "composite_id", "previous_revision_id", "target_revision_id", "state",
    "attempts", "phase",
    "scheduled_for", "started_at", "finished_at", "error_summary", "shadow_report", "activation",
    "retention", "created_at",
}
CONTRACTS = [
    contracts.test_start_reuses_the_row_scheduled_for_the_same_identity,
    contracts.test_state_machine_only_moves_forward,
    contracts.test_unreachable_transitions_are_rejected,
    contracts.test_activating_can_end_partial,
    contracts.test_unlocked_runs_returns_only_succeeded,
    contracts.test_shadow_and_activation_records_are_persisted,
    contracts.test_start_binds_the_target_revision,
    contracts.test_record_target_locks_once_switching_starts,
    contracts.test_retry_reuses_the_run_for_the_next_tick,
    contracts.test_retry_only_applies_to_failed_or_partial,
    contracts.test_retention_claim_and_release_are_idempotent,
    contracts.test_retention_requires_a_succeeded_run,
    contracts.test_scheduled_for_is_stored_as_utc_instants,
]


@pytest.fixture
def database(provider_pg):
    return provider_pg[0]


@pytest.mark.parametrize("contract", CONTRACTS, ids=lambda contract: contract.__name__)
def test_postgres_switch_run_contract(database, contract):
    contract(database)


def test_postgres_migration_creates_and_guards_switch_runs(provider_pg, monkeypatch):
    factory, engine = provider_pg
    path = Path(__file__).resolve().parents[2] / "migrations/versions/ba54_market_switch_runs.py"
    spec = importlib.util.spec_from_file_location("switch_pg_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    config = predecessor(engine, monkeypatch, migration.down_revision)
    with engine.begin() as conn:
        migration.op = Operations(MigrationContext.configure(conn))
        migration.upgrade()
        migration.upgrade()
        assert {column["name"] for column in inspect(conn).get_columns("market_switch_runs")} == COLUMNS
        assert {index["name"] for index in inspect(conn).get_indexes("market_switch_runs")} >= {
            "ix_market_switch_run_unlock", "ix_market_switch_run_dedupe"}
        migration.downgrade()
        assert not inspect(conn).has_table("market_switch_runs")
        migration.upgrade()
    complete(config, migration.revision)
    contracts.succeeded()
    with engine.begin() as conn:
        migration.op = Operations(MigrationContext.configure(conn))
        with pytest.raises(RuntimeError, match="备份"):
            migration.downgrade()
        assert inspect(conn).has_table("market_switch_runs")
