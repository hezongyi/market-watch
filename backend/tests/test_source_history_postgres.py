"""Run source applicability and snapshot recovery contracts on real PostgreSQL."""

import os

import pytest
import test_history_derivation as derivation
import test_source_calendar as calendars
from test_provider_postgres import provider_pg as provider_pg

pytestmark = pytest.mark.skipif(
    not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated Ubuntu Docker PostgreSQL"
)


@pytest.mark.parametrize("contract", [
    calendars.test_registration_binds_session_scope_and_revision_immutably,
    calendars.test_candidate_missing_gold_maintenance_cannot_be_certified_complete,
    calendars.test_source_observation_conflicting_with_reviewed_closure_is_preserved,
    calendars.test_revalidation_retracts_stale_candidate_complete_without_changing_observations,
    derivation.test_derived_version_reuses_original_chunks_even_if_staging_is_newer,
    derivation.test_partial_parent_is_quarantined_and_derived_task_continues_at_same_checkpoint,
    derivation.test_derivation_cannot_copy_another_series_or_discard_active_lease,
], ids=lambda contract: contract.__name__)
def test_source_snapshot_contract(provider_pg, contract):
    factory, _ = provider_pg
    contract(factory)


def test_live_source_session_contract(provider_pg, monkeypatch):
    factory, _ = provider_pg
    calendars.test_only_account_bound_review_can_certify_live_closed_interior(factory, monkeypatch)
