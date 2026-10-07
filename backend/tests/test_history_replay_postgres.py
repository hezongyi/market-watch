"""Fixed period replay on actual Ubuntu PostgreSQL, including retention races."""

import os

import pytest
import test_history_replay as contracts
from test_provider_postgres import provider_pg as provider_pg

pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated Ubuntu PostgreSQL")


@pytest.mark.parametrize("frame", ["M1", "M30", "H4", "D1", "W1", "MN"])
def test_fixed_period_contract(provider_pg, monkeypatch, frame):
    contracts.test_replay_reads_exact_closed_chart_artifacts_without_raw_m1(provider_pg[0], monkeypatch, frame)


@pytest.mark.parametrize("contract", [
    contracts.test_pinned_replay_inputs_and_manifest_survive_new_history_version,
    contracts.test_api_requires_explicit_version_and_seek_preserves_source_provenance,
    contracts.test_replay_pending_periods_are_rejected_without_synchronous_aggregation,
    contracts.test_unknown_period_retains_confirmation_and_pauses_simulated_judgment,
])
def test_fixed_replay_contract(provider_pg, contract):
    contract(provider_pg[0])
