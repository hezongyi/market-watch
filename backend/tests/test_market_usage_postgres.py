"""Actual PostgreSQL persistent composite demand resolution."""

import os

import pytest
import test_market_usage as contracts
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated Ubuntu PostgreSQL")


@pytest.mark.parametrize("contract", [
    contracts.test_first_use_and_management_create_no_demand_but_actual_chart_renews_shared_target,
    contracts.test_active_strategy_keeps_target_after_browser_closes_and_pausing_releases_it,
    contracts.test_current_chart_alert_version_and_expiry_own_persistent_demand,
    contracts.test_empty_residents_and_account_catalog_other_assets_idle_cleanly,
])
def test_postgres_market_usage(provider_pg, monkeypatch, contract):
    contract(provider_pg[0], monkeypatch)
