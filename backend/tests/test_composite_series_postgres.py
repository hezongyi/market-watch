"""Fixed confirmed/provisional composite reads on actual Ubuntu PostgreSQL."""

import os

import pytest
import test_composite_series as contracts
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated Ubuntu PostgreSQL")


@pytest.mark.parametrize("contract", [
    contracts.test_fixed_reader_uses_history_before_T_target_after_T_and_previous_input_prices,
    contracts.test_accepted_stream_tail_remains_provisional_after_owner_expires,
])
def test_postgres_composite_series(provider_pg, monkeypatch, contract):
    contract(provider_pg[0], monkeypatch)
