"""New continuation/merge/shared-input contracts on the task's isolated PG."""

import os

import pytest
import test_composite_aggregate_inputs as shared
import test_dataset_summaries as lists
import test_managed_continuation as continuation
import test_native_history_merge_cost as history
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated Ubuntu PostgreSQL")


@pytest.mark.parametrize("contract", [
    shared.test_shared_preparation_preserves_all_periods_and_reduces_queries,
    shared.test_shared_delta_is_pinned_and_read_once_for_different_period_windows,
    shared.test_shared_worker_keeps_task_leases_and_independent_period_commits,
    shared.test_new_input_and_expired_owner_cannot_change_shared_fixed_results,
    shared.test_failed_period_clears_shared_inputs_but_other_periods_continue,
    shared.test_three_identities_nine_periods_have_identical_confirmed_outputs,
    shared.test_frozen_revision_rejects_warm_shared_build_commit,
    continuation.test_enable_is_idempotent_and_disable_keeps_mapping_revision_and_history,
    continuation.test_multiple_valid_mappings_require_explicit_choice_and_stale_default_never_falls_back,
    continuation.test_all_old_configurations_remain_discoverable_after_default_change,
    lists.test_selected_continuation_health_is_batched_and_old_errors_do_not_taint_it,
    lists.test_active_calendar_revision_outside_page_retains_its_mapping_and_switch,
    lists.test_legacy_continuation_without_maintenance_is_listed_without_creating_plan,
    history.test_checkpoint_pages_decode_once_and_inherited_period_is_not_reencoded,
    history.test_unordered_corrections_across_staging_groups_match_ordered_oracle,
    history.test_inherited_refs_are_revalidated_before_publication,
])
def test_contract(provider_pg, monkeypatch, contract):
    contract(provider_pg[0], monkeypatch)


def test_list_anchor_rank(provider_pg):
    lists.test_batch_reports_removed_members_and_rank_changes(provider_pg[0])
