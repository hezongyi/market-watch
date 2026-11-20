"""Shared fixed periods on real PostgreSQL, including migration/FK reclamation."""

import importlib.util
import os
from pathlib import Path

import pytest
import test_history_artifact_sharing as sharing
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alerts.storage import HistoryArtifactBlock
from sqlalchemy import inspect, select, text
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(
    not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated Ubuntu PostgreSQL"
)


@pytest.mark.parametrize(
    "contract",
    [
        sharing.test_multiple_generations_resolve_one_hop_and_pagination,
        sharing.test_legacy_inline_blocks_are_adopted_without_mutating_payload,
        sharing.test_corrupt_original_payload_is_detected_through_shared_reference,
        sharing.test_shared_payload_rejects_other_frame_or_reference_chain,
        sharing.test_reclaim_removes_shared_and_inline_blocks_together,
    ],
    ids=lambda fn: fn.__name__,
)
def test_postgres_sharing_contract(provider_pg, contract):
    factory, _ = provider_pg
    contract(factory)


@pytest.mark.parametrize("date", ["2026-03-05", "2026-10-29"])
def test_postgres_shared_ny17_periods_match_recomputation(provider_pg, monkeypatch, date):
    factory, _ = provider_pg
    sharing.test_shared_ny17_periods_match_full_recomputation_across_dst(factory, monkeypatch, date)


@pytest.mark.parametrize("mismatch", ["dataset", "price_rule"])
def test_postgres_shared_scope(provider_pg, mismatch):
    factory, _ = provider_pg
    sharing.test_references_cannot_cross_dataset_or_frozen_price_rule(factory, mismatch)


def test_migration_preserves_inline_data_and_refuses_unsafe_downgrade(provider_pg):
    factory, engine = provider_pg
    path = Path(__file__).resolve().parents[2] / "migrations/versions/bf59_history_block_sharing.py"
    spec = importlib.util.spec_from_file_location("sharing_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    parent, child = sharing.prepared_pair(factory)
    with factory.begin() as db:
        original = list(db.execute(select(HistoryArtifactBlock.id, HistoryArtifactBlock.content)))
    with engine.begin() as c:
        with Operations.context(MigrationContext.configure(c)):
            migration.downgrade()
    with engine.begin() as c:
        assert "source_block_id" not in {
            v["name"] for v in inspect(c).get_columns("market_history_artifact_blocks")
        }
        with Operations.context(MigrationContext.configure(c)):
            migration.upgrade()
    with factory.begin() as db:
        assert (
            list(db.execute(select(HistoryArtifactBlock.id, HistoryArtifactBlock.content)))
            == original
        )
    sharing.finish(child)
    with engine.begin() as c:
        with Operations.context(MigrationContext.configure(c)):
            with pytest.raises(RuntimeError, match="Shared period payloads exist"):
                migration.downgrade()
        assert "source_block_id" in {
            v["name"] for v in inspect(c).get_columns("market_history_artifact_blocks")
        }
    # The canonical block is protected from a partial deletion by the real FK.
    from sqlalchemy.exc import IntegrityError

    with factory.begin() as db:
        source = db.scalar(
            select(HistoryArtifactBlock.source_block_id).where(
                HistoryArtifactBlock.source_block_id.is_not(None)
            )
        )
    with pytest.raises(IntegrityError):
        with engine.begin() as c:
            c.execute(
                text("DELETE FROM market_history_artifact_blocks WHERE id=:id"), dict(id=source)
            )
