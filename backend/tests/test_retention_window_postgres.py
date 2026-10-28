"""PostgreSQL contracts for the 30-day live-minute cleanup.

Every shared contract runs again on real PostgreSQL, where foreign keys and
row locking behave like production.
"""

import os

import pytest
import test_retention_window as contracts
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(
    not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated Ubuntu PostgreSQL"
)


@pytest.mark.parametrize("contract", [
    contracts.contract_window_boundary,
    contracts.contract_unlock_requires_persisted_success,
    contracts.contract_dry_run_reports_and_deletes_nothing,
    contracts.contract_foreign_key_order_and_idempotent_rerun,
    contracts.contract_interrupted_pass_resumes,
    contracts.contract_kill_between_commit_and_release_keeps_counts,
    contracts.contract_active_alert_blocks_the_batch,
    contracts.contract_mixed_batch_deletes_only_unprotected,
    contracts.contract_restore_gate_blocks_real_deletion,
    contracts.contract_tick_reports_reasons,
], ids=lambda contract: contract.__name__)
def test_postgres_retention_contract(provider_pg, contract):
    factory, _ = provider_pg
    contract(factory)
