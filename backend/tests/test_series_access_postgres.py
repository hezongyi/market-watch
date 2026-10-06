"""Qualified chart first-use and fixed workspace references on isolated PG."""

import os

import pytest
import test_series_access as contracts
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated Ubuntu PostgreSQL")


@pytest.mark.parametrize("contract", [
    contracts.test_search_resolve_watchlist_are_pure_and_first_data_read_is_idempotent,
    contracts.test_fixed_history_stays_on_version_after_daily_head_and_retains_workspace_reference,
    contracts.test_fixed_chart_never_silently_computes_indicator_on_page_prefix,
    contracts.test_fixed_export_uses_original_version_and_composite_snapshot_without_demand,
    contracts.test_fixed_export_rejects_actual_row_overflow_without_import_jobs,
])
def test_qualified_chart_contract(provider_pg, monkeypatch, contract):
    contract(provider_pg[0], monkeypatch)
