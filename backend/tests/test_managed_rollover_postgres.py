"""Run the managed rotation contracts on task-owned PostgreSQL schemas."""

import os

import pytest
import test_managed_rollover as contracts
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg

pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated PostgreSQL")


@pytest.mark.parametrize("contract", [
    contracts.test_published_without_completed_maintenance_never_queues_a_candidate,
    contracts.test_required_unavailable_artifact_cannot_take_over,
    contracts.test_saved_mapping_is_used_even_when_another_reviewed_mapping_exists,
    contracts.test_candidate_catches_old_tail_and_activates_once_without_changing_identity,
    contracts.test_fixed_price_alert_defers_auto_activation_and_remains_active,
    contracts.test_new_fixed_rule_after_preflight_is_checked_again_at_activation,
    contracts.test_late_confirmation_invalidates_candidate_activation_input,
    contracts.test_disabling_realtime_or_automation_blocks_a_ready_candidate,
], ids=lambda contract: contract.__name__)
def test_postgres_rotation(provider_pg, monkeypatch, contract):
    factory, _ = provider_pg
    contract(factory, monkeypatch)
