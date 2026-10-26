"""Retained archive records remain readable on actual PostgreSQL."""
import os

import pytest
import test_history_replay as contracts
from test_provider_postgres import provider_pg as provider_pg

pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated Ubuntu PostgreSQL")

@pytest.mark.parametrize("contract", [
    contracts.test_pinned_replay_inputs_and_manifest_survive_new_history_version,
    contracts.test_archived_packed_and_legacy_snapshots_decode_with_cutoff,
])
def test_archived_replay_contract(provider_pg, contract):
    contract(provider_pg[0])
