"""Concurrent actual first-use commands select one baseline and prepare job."""

import importlib.util
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
import test_composite_definitions as contracts
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alerts.composite_definitions import first_use, save_mapping
from alerts.storage import (
    CompositeAggregateBar,
    CompositeAggregateTask,
    CompositeInputEvent,
    CompositeMinute,
    CompositeMinuteInput,
    CompositePreparation,
    CompositeReadAttempt,
    CompositeRevision,
    MarketComposite,
    RealtimeMapping,
)
from sqlalchemy import func, inspect, select
from test_market_contracts import identity
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated Ubuntu PostgreSQL")


@pytest.mark.parametrize("contract", [
    contracts.test_saved_mapping_has_explicit_proof_and_creates_no_demand,
    contracts.test_first_use_fixes_baseline_and_seam_and_daily_publish_does_not_replace_it,
    contracts.test_first_use_requires_fixed_published_m1_not_only_registered_source,
])
def test_postgres_composite_definition(provider_pg, monkeypatch, contract):
    factory, _ = provider_pg
    contract(factory, monkeypatch)


def test_concurrent_first_use_creates_one_definition_revision_and_preparation(provider_pg, monkeypatch):
    factory, _ = provider_pg
    catalog = contracts.prepare(factory, monkeypatch)
    parent = contracts.publish(factory)
    with factory.begin() as db:
        mapping_id = save_mapping(db, identity().key, catalog, contracts.PROOF).id
    def open_composite(_):
        with factory.begin() as db:
            composite = first_use(db, identity().key, mapping_id)
            return composite.id, composite.active_revision_id
    with ThreadPoolExecutor(max_workers=4) as pool:
        opened = list(pool.map(open_composite, range(8)))
    assert len(set(opened)) == 1
    with factory.begin() as db:
        assert db.scalar(select(func.count()).select_from(MarketComposite)) == 1
        assert db.scalar(select(func.count()).select_from(CompositeRevision)) == 1
        assert db.scalar(select(func.count()).select_from(CompositePreparation)) == 1
        assert db.get(CompositeRevision, opened[0][1]).history_version_id == parent


def test_additive_migration_and_no_unreviewed_mapping_loss(provider_pg, monkeypatch):
    factory, engine = provider_pg
    path = Path(__file__).resolve().parents[2] / "migrations/versions/ae32_composite_definitions.py"
    spec = importlib.util.spec_from_file_location("composite_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    with engine.begin() as conn:
        for model in (CompositeAggregateBar, CompositeAggregateTask, CompositeMinute, CompositeMinuteInput, CompositeInputEvent, CompositeReadAttempt, CompositePreparation,
                      CompositeRevision, MarketComposite, RealtimeMapping):
            model.__table__.drop(conn)
        migration.op = Operations(MigrationContext.configure(conn))
        migration.upgrade()
        assert "market_composite_preparations" in inspect(conn).get_table_names()
    catalog = contracts.prepare(factory, monkeypatch)
    with factory.begin() as db:
        save_mapping(db, identity().key, catalog, contracts.PROOF)
    with engine.begin() as conn:
        migration.op = Operations(MigrationContext.configure(conn))
        with pytest.raises(RuntimeError, match="backup"):
            migration.downgrade()
