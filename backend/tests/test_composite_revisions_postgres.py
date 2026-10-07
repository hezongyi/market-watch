"""Actual PG revision request/activation isolation and contention."""

import os
from concurrent.futures import ThreadPoolExecutor

import pytest
import test_composite_revisions as contracts
from alerts.composite_revisions import activate, create
from alerts.storage import CompositeActivation, CompositeRevisionChange, MarketComposite
from sqlalchemy import func, select
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated Ubuntu PostgreSQL")


@pytest.mark.parametrize("contract", [
    contracts.test_preparation_is_idempotent_pure_reads_and_atomic_activation,
    contracts.test_non_day_boundary_and_concurrent_activation_are_explicit,
    contracts.test_calendar_derivation_and_mapping_keep_old_rule_and_series_identity,
    contracts.test_captured_indicator_warmup_must_finish_before_activation,
    contracts.test_authenticated_revision_contract_and_pure_options,
    contracts.test_pending_revision_polling_rotates_past_twenty_waiting_tasks,
])
def test_revision_contract(provider_pg, monkeypatch, contract):
    contract(provider_pg[0], monkeypatch)


def test_concurrent_creation_and_activation_are_single_and_transactional(provider_pg, monkeypatch):
    factory, _ = provider_pg
    composite, old, body = contracts.request(factory, monkeypatch)

    def create_once(_):
        with factory.begin() as db:
            return create(db, composite, body).id

    with ThreadPoolExecutor(max_workers=4) as executor:
        ids = list(executor.map(create_once, range(8)))
    assert len(set(ids)) == 1
    ident = ids[0]
    contracts.prepared(factory, ident)
    with pytest.raises(RuntimeError, match="rollback"):
        with factory.begin() as db:
            activate(db, composite, ident, {"request_id": "atomic-test", "expected_revision_id": old})
            raise RuntimeError("rollback")
    with factory() as db:
        assert db.get(MarketComposite, composite).active_revision_id == old
        assert db.get(CompositeActivation, ident) is None

    def activate_once(_):
        with factory.begin() as db:
            return activate(db, composite, ident, {"request_id": "atomic-test", "expected_revision_id": old}).revision_id

    with ThreadPoolExecutor(max_workers=4) as executor:
        assert list(executor.map(activate_once, range(8))) == [ident] * 8
    with factory() as db:
        assert db.get(MarketComposite, composite).active_revision_id == ident
        assert db.scalar(select(func.count()).select_from(CompositeRevisionChange)) == 1
        assert db.scalar(select(func.count()).select_from(CompositeActivation)) == 1


def test_additive_migration_and_populated_downgrade_protection(provider_pg, monkeypatch):
    import importlib.util
    from pathlib import Path

    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    from sqlalchemy import inspect

    factory, engine = provider_pg
    composite, _, body = contracts.request(factory, monkeypatch)
    path = Path(__file__).resolve().parents[2] / "migrations/versions/aj37_composite_revision_changes.py"
    spec = importlib.util.spec_from_file_location("revision_changes", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    with engine.begin() as connection:
        CompositeActivation.__table__.drop(connection)
        CompositeRevisionChange.__table__.drop(connection)
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        assert "market_composite_activations" in inspect(connection).get_table_names()
    with factory.begin() as db:
        create(db, composite, body)
    with engine.begin() as connection:
        migration.op = Operations(MigrationContext.configure(connection))
        with pytest.raises(RuntimeError, match="backup"):
            migration.downgrade()
