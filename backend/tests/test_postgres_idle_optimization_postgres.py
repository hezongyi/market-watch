"""Demand-bound derivation and quote transactions on isolated PostgreSQL."""
import inspect
import os

import pytest
import test_postgres_idle_optimization as contracts
from alerts import storage
from test_live_pricing import running as live_running
from test_provider_postgres import provider_pg as provider_pg

pytestmark = pytest.mark.skipif(not os.getenv('TEST_POSTGRES_URL'),
                               reason='Requires isolated Ubuntu PostgreSQL')


@pytest.mark.parametrize('case', [
    'test_normal_projection_turn_does_not_run_compatibility_history',
    'test_confirmation_discovery_only_returns_due_data_and_keeps_commit_fence',
    'test_collector_handover_cache_is_populated_only_after_a_successful_commit',
    'test_mapped_disabled_target_defers_derived_work_but_new_read_resumes',
    'test_idle_aggregation_keeps_future_retry_deadline',
    'test_native_pending_future_lease_is_not_classified_idle',
    'test_paused_ranges_coalesce_keep_retries_and_replay_corrected_extreme',
    'test_unchanged_gap_is_not_rediscovered_but_fresh_input_requests_it',
])
def test_pg_idle_contract(provider_pg, monkeypatch, case):
    factory, engine = provider_pg
    storage.bootstrap(engine)
    fn = getattr(contracts, case)
    arguments = {'database': factory, 'monkeypatch': monkeypatch}
    if 'running' in inspect.signature(fn).parameters:
        arguments['running'] = live_running.__wrapped__(factory, monkeypatch)
    fn(**{key: arguments[key] for key in inspect.signature(fn).parameters})
