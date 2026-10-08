"""Ubuntu isolated PostgreSQL concurrency gates; skips are not acceptance."""

import os
from concurrent.futures import ThreadPoolExecutor

import pytest
import test_market_stream as contracts
from alerts import market_stream as stream
from alerts.storage import MarketStreamTask
from sqlalchemy import func, select
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"),
                               reason="Requires isolated Ubuntu PostgreSQL")


@pytest.mark.parametrize("contract", [
    contracts.test_multiple_pages_share_one_calculation_and_session_scopes_listeners,
    contracts.test_old_cancel_duplicate_register_and_late_register_do_not_remove_new_generation,
    contracts.test_expired_owner_cannot_publish_after_successor,
    contracts.test_result_sequence_rejects_stale_same_bar_and_recovers_or_resets,
    contracts.test_session_end_disables_work_and_output,
    contracts.test_worker_affinity_keeps_current_bucket_owner_until_failure_takeover,
    contracts.test_unconfirmed_previous_minute_retraction_requires_history_restore,
    contracts.test_empty_first_history_receives_status_then_recovery_before_native_bars,
    contracts.test_replay_checks_each_committed_result_without_looking_ahead,
    contracts.test_disconnect_beyond_retained_bar_window_requires_reset,
    contracts.test_indicator_only_change_delivers_native_bar_at_its_own_time,
])
def test_durable_contract(provider_pg, contract):
    contract(provider_pg[0])


def test_concurrent_clients_and_workers_share_one_task_and_one_claim(provider_pg):
    factory, _ = provider_pg
    owner = contracts.session(factory)
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda i: contracts.register(owner, client="page" + str(i)), range(8)))
    assert len({row["task_id"] for row in results}) == 1
    with factory.begin() as db:
        assert db.scalar(select(func.count()).select_from(MarketStreamTask)) == 1
    with ThreadPoolExecutor(max_workers=4) as pool:
        claims = [work for work in pool.map(lambda i: stream.claim(owner="worker" + str(i)), range(4)) if work]
    assert len(claims) == 1
    stream.commit(claims[0], {"type": "status", "status": "ready"})
