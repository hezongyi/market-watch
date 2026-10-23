"""The chart policy uses real PostgreSQL persistence and lease fencing."""

import os
from concurrent.futures import ThreadPoolExecutor

import pytest
import test_observed_indicators as contracts
from alerts import fixed_indicators as jobs
from alerts.chart_api import DataQuery, data_sync
from alerts.observed_indicators import OBSERVED
from alerts.storage import FixedIndicatorRun
from sqlalchemy import func, select
from test_fixed_indicators import drain, history
from test_provider_postgres import provider_pg as provider_pg

pytestmark = pytest.mark.skipif(
    not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated PostgreSQL"
)


@pytest.mark.parametrize(
    "contract",
    [
        contracts.test_display_and_strict_runs_have_separate_identities,
        contracts.test_retained_snapshot_keeps_its_original_forming_clock,
        contracts.test_foreground_never_substitutes_durable_prices_for_snapshot,
        contracts.test_incomplete_higher_period_api_returns_observed_values_preserving_strict,
    ],
)
def test_policy_persistence(provider_pg, monkeypatch, contract):
    contract(provider_pg[0], monkeypatch)


@pytest.mark.parametrize("spec", [contracts.SPEC, contracts.SWING, contracts.SUPER])
def test_snapshot_persistence(provider_pg, monkeypatch, spec):
    contracts.test_composite_snapshot_suffix_and_pagination_are_fenced(
        provider_pg[0], monkeypatch, spec
    )


def test_long_shared_run_and_worker_lease_fencing(provider_pg, monkeypatch):
    factory = provider_pg[0]
    version = history(factory, monkeypatch, count=4500)
    body = DataQuery(
        instrument=version,
        series_kind="history",
        timeframe="M1",
        limit=20,
        indicators=[contracts.SPEC],
        indicator_input_policy=OBSERVED,
    )
    with ThreadPoolExecutor(max_workers=2) as pool:
        ids = list(pool.map(lambda _: data_sync(body)["indicator_progress"][0]["run_id"], range(2)))
    assert ids[0] == ids[1]
    with factory.begin() as db:
        assert db.scalar(select(func.count()).select_from(FixedIndicatorRun)) == 1
    owner = jobs.claim(ids[0])
    page = jobs.build(owner)
    assert len(page["rows"]) == 2000 and not page["done"]
    with factory.begin() as db:
        db.get(FixedIndicatorRun, ids[0]).lease_until = 0
    replacement = jobs.claim(ids[0])
    with pytest.raises(TimeoutError):
        jobs.commit(owner, page)
    jobs.commit(replacement, jobs.build(replacement))
    drain(ids[0])
    with factory.begin() as db:
        run = db.get(FixedIndicatorRun, ids[0])
        assert run.status == "complete" and run.state["observed"]["n"] == 4500
    assert data_sync(body)["indicators"][0]["calculation"]["visible_complete"]
