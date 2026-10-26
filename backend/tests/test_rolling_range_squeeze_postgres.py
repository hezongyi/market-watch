"""Squeeze contracts against an isolated PostgreSQL schema, never mwa data."""

import os
from concurrent.futures import ThreadPoolExecutor

import pytest
import test_rolling_range_squeeze as contracts
from alerts import fixed_indicators as jobs
from alerts.chart_query import DataQuery, data_sync
from alerts.storage import FixedIndicatorRun
from test_fixed_indicators import drain, history
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(
    not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated Ubuntu PostgreSQL"
)


@pytest.mark.parametrize("policy", ["strict_confirmed_v1", "observed_display_v1"])
def test_durable_history_presentation(provider_pg, monkeypatch, policy):
    contracts.test_fixed_history_worker_pagination_and_durable_presentation(
        provider_pg[0], monkeypatch, policy
    )


@pytest.mark.parametrize("contract", [
    contracts.test_provider_snapshot_old_viewport_keeps_full_boxes,
    contracts.test_composite_preview_is_page_independent_and_not_persisted,
])
def test_snapshot_contract(provider_pg, monkeypatch, contract):
    contract(provider_pg[0], monkeypatch)


def test_concurrent_requests_own_one_run_and_persist_boolean_checkpoint(provider_pg, monkeypatch):
    factory, _ = provider_pg
    version = history(factory, monkeypatch, count=70)
    spec = {"name": contracts.NAME, "params": {
        "k": 1, "lookback": 20, "low_pct": 50, "confirm_on_close": False,
    }}
    query = DataQuery(instrument=version, series_kind="history", timeframe="M1",
                      limit=7, indicators=[spec])

    def first(_):
        return data_sync(query)["indicator_progress"][0]["run_id"]

    with ThreadPoolExecutor(max_workers=2) as pool:
        ids = list(pool.map(first, range(4)))
    assert len(set(ids)) == 1
    with ThreadPoolExecutor(max_workers=2) as pool:
        owners = [owner for owner in pool.map(lambda _: jobs.claim(ids[0]), range(2)) if owner]
    assert len(owners) == 1
    jobs.commit(owners[0], jobs.build(owners[0]))
    with pytest.raises(TimeoutError):
        jobs.commit(owners[0], jobs.build(owners[0]))
    drain(ids[0])
    with factory.begin() as db:
        run = db.get(FixedIndicatorRun, ids[0])
        assert run.spec["params"]["confirm_on_close"] is False
        assert run.state["spec"]["params"]["confirm_on_close"] is False
        assert len(run.state["state"]["ratios"]) == 20
        assert run.state["state"]["boxes"]
    result = data_sync(query)["indicators"][0]
    assert result["presentation"]["history_complete"] is True
    assert result["presentation"]["boxes"]
