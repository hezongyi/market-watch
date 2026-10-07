"""Concurrent reference creation and reclamation serialize on PostgreSQL."""

import os
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
import test_history_retention as contracts
from alerts.history_replay import create_replay
from alerts.history_retention import reclaim
from alerts.storage import Instrument
from test_market_contracts import identity
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated Ubuntu PostgreSQL")


@pytest.mark.parametrize("contract", [
    contracts.test_reclaim_preserves_identity_manifest_and_retries_but_not_old_payload,
    contracts.test_saved_replay_and_workspace_block_reclamation,
    contracts.test_completed_maintenance_with_new_pending_period_still_blocks_reclaim,
    contracts.test_source_cache_is_retained_and_unreachable_blob_is_reclaimed,
    contracts.test_shared_blob_without_cache_remains_reachable_from_independent_dataset,
    contracts.test_new_workspace_cannot_reference_reclaimed_version_after_precheck,
], ids=lambda contract: contract.__name__)
def test_postgres_retention_contract(provider_pg, contract):
    factory, _ = provider_pg
    contract(factory)


def test_reclamation_wins_then_new_replay_reference_is_rejected(provider_pg, monkeypatch):
    import alerts.history_retention as retention

    factory, _ = provider_pg
    ident, instrument = contracts.prepared(factory, frames=("M1", "H4", "D1"))
    held, release, replay_started = threading.Event(), threading.Event(), threading.Event()
    original = retention.references

    def controlled(db, dataset):
        result = original(db, dataset)
        held.set()
        assert release.wait(5)
        return result

    monkeypatch.setattr(retention, "references", controlled)

    def clear():
        with factory.begin() as db:
            return reclaim(db, identity().key, "race")

    def reference():
        with factory.begin() as db:
            replay_started.set()
            return create_replay(db, db.get(Instrument, instrument), ident, "M1", 0, 120000)

    with ThreadPoolExecutor(max_workers=2) as pool:
        clearing = pool.submit(clear)
        assert held.wait(5)
        referencing = pool.submit(reference)
        assert replay_started.wait(5)
        release.set()
        assert clearing.result(timeout=10)["versions"] == 1
        with pytest.raises(ValueError, match="回收"):
            referencing.result(timeout=10)


def test_new_reference_wins_then_reclamation_is_rejected(provider_pg):
    factory, _ = provider_pg
    ident, instrument = contracts.prepared(factory, frames=("M1", "H4", "D1"))
    held, release, clear_started = threading.Event(), threading.Event(), threading.Event()

    def reference():
        with factory.begin() as db:
            run = create_replay(db, db.get(Instrument, instrument), ident, "M1", 0, 120000)
            held.set()
            assert release.wait(5)
            return run.id

    def clear():
        with factory.begin() as db:
            clear_started.set()
            return reclaim(db, identity().key, "race")

    with ThreadPoolExecutor(max_workers=2) as pool:
        referencing = pool.submit(reference)
        assert held.wait(5)
        clearing = pool.submit(clear)
        assert clear_started.wait(5)
        release.set()
        assert referencing.result(timeout=10)
        with pytest.raises(ValueError, match="引用"):
            clearing.result(timeout=10)
