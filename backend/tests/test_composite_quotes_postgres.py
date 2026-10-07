"""Real isolated PostgreSQL quote fences and HTTP no-demand contract."""

import os

import pytest
import test_composite_quotes as contracts
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated PostgreSQL")


@pytest.mark.parametrize("contract", [
    contracts.test_live_quote_is_independent_of_recovery_and_exact_input_is_auditable,
    contracts.test_watchlist_http_uses_exact_snapshot_and_never_renews_demand,
])
def test_composite_quote_postgres(provider_pg, monkeypatch, contract):
    contract(provider_pg[0], monkeypatch)


@pytest.mark.parametrize("change", ["epoch", "quote_epoch", "expired", "account", "received_stale"])
def test_composite_quote_fences_postgres(provider_pg, monkeypatch, change):
    contracts.test_invalid_or_expired_owner_never_promotes_stream_price(provider_pg[0], monkeypatch, change)
