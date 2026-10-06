"""Real PostgreSQL managed maintenance, checkpoints and concurrent submissions."""

import os
from concurrent.futures import ThreadPoolExecutor

import pytest
import test_history_maintenance as contracts
from alerts.history_maintenance import configure, create_run
from alerts.storage import HistoryRun
from sqlalchemy import func, select
from test_market_contracts import identity
from test_market_datasets import register
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"),
                               reason="Requires isolated Ubuntu PostgreSQL")


@pytest.mark.parametrize("contract", [
    contracts.test_incremental_run_reuses_unchanged_prefix_and_fixed_parent,
    contracts.test_failed_update_keeps_old_published_history_and_retry_checkpoint,
    contracts.test_explicit_recheck_reuses_both_sides_and_preserves_unknown_rules,
    contracts.test_pause_task_waits_for_checkpoint_and_drops_inflight_result,
    contracts.test_daily_schedule_is_separate_from_pause_and_read_has_no_live_demand,
    contracts.test_maintenance_success_waits_for_all_fixed_requested_artifacts,
    contracts.test_cancel_artifact_stage_preserves_m1_and_partial_periods,
], ids=lambda contract: contract.__name__)
def test_postgres_maintenance_contract(provider_pg, contract):
    factory, _ = provider_pg
    contract(factory)


def test_concurrent_task_submission_keeps_one_fixed_version(provider_pg):
    factory, _ = provider_pg
    with factory.begin() as db:
        register(db)
        configure(db, identity().key, target_start=0, timeframes=["M1"])

    def submit(_):
        with factory.begin() as db:
            return create_run(db, identity().key, end=120000, request_id="shared").id

    with ThreadPoolExecutor(max_workers=4) as pool:
        ids = list(pool.map(submit, range(8)))
    assert len(set(ids)) == 1
    with factory.begin() as db:
        assert db.scalar(select(func.count()).select_from(HistoryRun)) == 1


def test_parallel_artifacts_complete_shared_task_once(provider_pg):
    from alerts.history_artifacts import artifact_tick
    from alerts.history_maintenance import finish_run, plan_report
    from alerts.history_versions import import_page

    factory, _ = provider_pg
    with factory.begin() as db:
        register(db)
        configure(db, identity().key, target_start=0, timeframes=["M1", "H4"])
        ident = create_run(db, identity().key, end=120000, request_id="parallel").id
    import_page(contracts.Adapter(), version_id=ident)
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert all(pool.map(lambda _: artifact_tick(ident), range(2)))
    with factory.begin() as db:
        stamp = db.get(HistoryRun, ident).completed_at
        assert stamp is not None
        assert plan_report(db, identity().key)["last_success"] == stamp
        assert not finish_run(db, ident)
        assert db.get(HistoryRun, ident).completed_at == stamp


def test_old_period_availability_during_new_m1_publication(provider_pg):
    from test_data_center import test_new_m1_publication_preserves_previous_period_usability

    factory, _ = provider_pg
    test_new_m1_publication_preserves_previous_period_usability(factory)
