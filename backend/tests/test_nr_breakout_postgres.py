"""NR checkpoints and worker fencing in an isolated PostgreSQL schema."""

import os
from concurrent.futures import ThreadPoolExecutor

import pytest
import test_nr_breakout as contracts
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
def test_nr_checkpoint_pagination(provider_pg, monkeypatch, policy):
    contracts.test_fixed_worker_checkpoint_and_historical_pagination_match_batch(
        provider_pg[0], monkeypatch, policy
    )


@pytest.mark.parametrize("policy", ["strict_confirmed_v1", "observed_display_v1"])
def test_nr_concurrent_requests_and_json_checkpoint(provider_pg, monkeypatch, policy):
    factory, _ = provider_pg
    version = history(factory, monkeypatch, count=160)
    monkeypatch.setattr(jobs, "PAGE_SIZE", 37)
    query = DataQuery(instrument=version, series_kind="history", timeframe="M1",
                      limit=17, indicators=[{"name": contracts.NAME, "params": {"timeframe": "5"}}],
                      indicator_input_policy=policy)

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
        assert run.status == "complete"
        assert run.state["spec"]["params"]["timeframe"] == "5"
        assert len(run.state["state"]["ranges"]) == 7
        assert run.state["state"]["rh"] is not None
        assert run.algorithm.endswith("nr4-nr7-breakout-state-v1")
    result = data_sync(query)
    assert not result["pending"]
    assert len(result["indicators"][0]["series"]) == len(contracts.OUTPUTS)
