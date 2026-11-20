"""Retirement uses real PostgreSQL rollback and reference fences."""

import os
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
import test_compatibility_retirement as contracts
from alerts.compatibility_retirement import retire, retired
from alerts.storage import AdvancedWorkspace
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(
    not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated Ubuntu PostgreSQL"
)


@pytest.mark.parametrize(
    "contract",
    [
        contracts.test_retirement_clears_only_tasks_and_cannot_be_woken_by_old_chart,
        contracts.test_retirement_preserves_new_confirmed_input_and_avoids_inline_aggregation,
        contracts.test_retirement_refuses_independent_consumer_and_is_atomic,
        contracts.test_retirement_preview_and_unrelated_aggregates_remain_unchanged,
        contracts.test_retired_legacy_mutations_and_demands_are_rejected,
        contracts.test_retired_completed_alert_cannot_restart_but_keeps_history,
    ],
)
def test_retirement_contract(provider_pg, monkeypatch, contract):
    contract(provider_pg[0], monkeypatch)


@pytest.mark.parametrize("model", ["AdvancedWorkspace", "ChartWorkspace", "AdvancedPreference"])
def test_saved_reference_contract(provider_pg, monkeypatch, model):
    contracts.test_saved_layout_prevents_retirement_and_cannot_be_recreated_afterward(
        provider_pg[0], monkeypatch, model
    )


@pytest.mark.parametrize("first", ["retire", "save"])
def test_retirement_and_saved_layout_serialize(provider_pg, monkeypatch, first):
    factory, _ = provider_pg
    ident, _, _, _ = contracts.setup_target(factory, monkeypatch)
    locked, release, started = threading.Event(), threading.Event(), threading.Event()

    def operation(kind, owner):
        with factory.begin() as db:
            if not owner:
                started.set()
            if kind == "retire":
                retire(db, [ident], apply=True)
            else:
                db.add(AdvancedWorkspace(name="saved", document={"instrument": ident}))
                db.flush()
            if owner:
                locked.set()
                assert release.wait(5)

    with ThreadPoolExecutor(max_workers=2) as pool:
        owner = pool.submit(operation, first, True)
        assert locked.wait(5)
        waiter = pool.submit(operation, "save" if first == "retire" else "retire", False)
        try:
            assert started.wait(5)
            assert not waiter.done()
        finally:
            release.set()
        owner.result(timeout=5)
        with pytest.raises(ValueError, match="退役|Saved consumer"):
            waiter.result(timeout=5)
    with factory() as db:
        assert retired(db, ident) == (first == "retire")
