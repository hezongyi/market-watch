"""Sparse daily price evidence with real PostgreSQL JSON demand and row leases."""

import os
from concurrent.futures import ThreadPoolExecutor

import pytest
import test_composite_price_confirmation as contracts
from alerts import composite_price_confirmation as prices
from alerts.chart_alert_worker import evaluate
from alerts.storage import SourceFetch
from sqlalchemy import select
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated Ubuntu PostgreSQL")


@pytest.mark.parametrize("contract", [
    contracts.test_sparse_day_waits_for_price_evidence_without_marking_fresh_quotes_stale,
    contracts.test_matching_account_native_day_baselines_then_allows_new_cross_without_filling_minutes,
    contracts.test_native_price_proof_does_not_release_indicator_dependencies_or_disconnected_quotes,
    contracts.test_account_switch_cannot_fetch_or_reuse_price_evidence,
    contracts.test_corrected_minutes_require_new_match_and_never_replay_old_cross,
    contracts.test_duplicate_workers_and_obsolete_lease_cannot_publish,
])
def test_price_evidence_contract(provider_pg, monkeypatch, contract):
    contract(provider_pg[0], monkeypatch)


@pytest.mark.parametrize("status", ["paused", "expired"])
def test_cancelled_source_demand(provider_pg, monkeypatch, status):
    contracts.test_background_source_demand_stops_with_its_last_active_rule(provider_pg[0], monkeypatch, status)


def test_competing_workers_claim_one_native_window(provider_pg, monkeypatch):
    factory, _ = provider_pg
    ident, _, _, _, _, stamp = contracts.sparse_daily(factory, monkeypatch)
    with factory.begin() as db:
        evaluate(db, ident, now=stamp)
    with ThreadPoolExecutor(max_workers=2) as pool:
        owned = list(pool.map(lambda _: prices.claim(), range(4)))
    assert sum(value is not None for value in owned) == 1


def test_source_io_holds_no_database_or_evaluator_lock(provider_pg, monkeypatch):
    factory, _ = provider_pg
    ident, _, _, seam, end, stamp = contracts.sparse_daily(factory, monkeypatch)
    with factory.begin() as db:
        evaluate(db, ident, now=stamp)
    adapter, client, _ = contracts.source_adapter(seam, end)
    original = adapter.rest_get

    def get(url, **kwargs):
        with factory.begin() as db:
            # A separate PostgreSQL connection can take this lock immediately
            # while the actual native HTTP request is about to run.
            task = db.scalar(select(SourceFetch).where(SourceFetch.id.startswith("ohlc:"))
                             .with_for_update(nowait=True))
            assert task.lease_token and task.content_id is None
        return original(url, **kwargs)

    adapter.rest_get = get
    try:
        assert prices.once(adapter)
    finally:
        client.close()
