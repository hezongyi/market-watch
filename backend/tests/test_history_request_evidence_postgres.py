"""Real isolated PostgreSQL evidence, migrations and original creation retries."""

import importlib.util
import os
from pathlib import Path

import pytest
import test_data_center as center
import test_history_request_evidence as contracts
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import MetaData, Table, inspect
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated Ubuntu PostgreSQL")


@pytest.mark.parametrize("contract", [
    contracts.test_failed_request_survives_retry_and_success_has_no_failed_missing_minutes,
    contracts.test_crash_recovery_marks_unknown_outcome_and_fences_late_reader,
    contracts.test_read_evidence_survives_price_reclamation_and_does_not_block_it,
])
def test_postgres_read_evidence(provider_pg, contract):
    factory, _ = provider_pg
    contract(factory)


@pytest.mark.parametrize("use_catalog", [False, True])
def test_postgres_retry_before_mutable_catalogue(provider_pg, monkeypatch, use_catalog):
    factory, _ = provider_pg
    center.test_create_retry_uses_fixed_request_before_mutable_catalogue(factory, monkeypatch, use_catalog)


def test_postgres_request_evidence_additive_migration_and_data_loss_guard(provider_pg):
    factory, engine = provider_pg
    path = Path(__file__).resolve().parents[2] / "migrations/versions/ad31_history_read_attempts.py"
    spec = importlib.util.spec_from_file_location("read_evidence_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    with engine.begin() as conn:
        from alerts.storage import HistoryReadAttempt
        HistoryReadAttempt.__table__.drop(conn)
        migration.op = Operations(MigrationContext.configure(conn))
        migration.upgrade()
        assert "market_history_read_attempts" in inspect(conn).get_table_names()
    ident, _ = contracts.create(factory)
    with engine.begin() as conn:
        # Exercise ad31's historical table shape; today's worker expects columns
        # introduced by later migrations and cannot write this older schema.
        attempts = Table("market_history_read_attempts", MetaData(), autoload_with=conn)
        conn.execute(attempts.insert().values(
            id="00000000-0000-0000-0000-000000000001", version_id=ident,
            start=0, end=120000, started_at=1, finished_at=2,
            read_kind="supplier_request", result="data", accepted=True,
        ))
        migration.op = Operations(MigrationContext.configure(conn))
        with pytest.raises(RuntimeError, match="backup"):
            migration.downgrade()
