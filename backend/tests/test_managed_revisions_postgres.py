"""Managed publication correctness on a unique PostgreSQL schema."""

import importlib.util
import os
import uuid
from pathlib import Path

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alerts import storage
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from test_managed_dataset import (
    test_derived_corrections_wait_for_aggregation_and_survive_rollback as check_derived,
)
from test_managed_dataset import (
    test_published_history_check_tracks_corrections_inside_frozen_session as check_history,
)
from test_managed_dataset import (
    test_published_internal_revision_outside_tail_is_eventually_visible as check_internal,
)

pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated PostgreSQL")


@pytest.fixture
def managed_pg(monkeypatch):
    url = os.environ["TEST_POSTGRES_URL"]
    schema = "managed_revisions_" + uuid.uuid4().hex
    admin = create_engine(url, pool_size=1, max_overflow=0)
    with admin.begin() as conn:
        conn.execute(text(f"CREATE SCHEMA {schema}"))
    engine = create_engine(url, connect_args={"options": f"-csearch_path={schema}"},
                           pool_size=1, max_overflow=0)
    storage.bootstrap(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(storage, "Session", factory)
    try:
        yield factory, engine
    finally:
        engine.dispose()
        with admin.begin() as conn:
            conn.execute(text(f"DROP SCHEMA {schema} CASCADE"))
        admin.dispose()


def test_pg_internal_correction_is_durable_and_eventually_published(managed_pg):
    check_internal(managed_pg[0])


def test_pg_frozen_history_check_excludes_appends_and_detects_corrections(managed_pg):
    check_history(managed_pg[0])


def test_pg_derived_correction_waits_for_aggregation_and_rolls_back_atomically(managed_pg, monkeypatch):
    check_derived(managed_pg[0], monkeypatch)


def test_pg_revision_migration_preserves_snapshots_and_seeds_reconciliation(managed_pg):
    check_history(managed_pg[0])
    path = Path(__file__).resolve().parents[2] / "migrations/versions/o16_managed_revisions.py"
    spec = importlib.util.spec_from_file_location("managed_revision_pg_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    with managed_pg[1].begin() as conn:
        before = conn.execute(text("SELECT payload FROM chart_published_bars ORDER BY start")).all()
        migration.op = Operations(MigrationContext.configure(conn))
        for _ in range(2):
            migration.downgrade()
            assert conn.execute(text("SELECT payload FROM chart_published_bars ORDER BY start")).all() == before
            migration.upgrade()
            assert conn.execute(text("SELECT count(*) FROM chart_publication_jobs")).scalar() == len(before)
            assert conn.execute(text("SELECT payload FROM chart_published_bars ORDER BY start")).all() == before
