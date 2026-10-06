"""Qualified chart first-use and fixed workspace references on isolated PG."""

import os

import pytest
import test_fixed_series_revisions as revisions
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


@pytest.mark.parametrize("contract", [
    revisions.test_prefix_stamp_ignores_appends_and_excluded_latest_bucket_but_detects_older_correction,
    revisions.test_outside_loaded_range_does_not_reset_but_correction_inside_does,
    revisions.test_gap_fill_inside_loaded_prefix_changes_stamp,
    revisions.test_high_period_check_uses_real_bucket_starts_and_excludes_entire_tail_bucket,
    revisions.test_immutable_history_check_stays_on_original_input,
])
def test_fixed_revision_contract(provider_pg, monkeypatch, contract):
    contract(provider_pg[0], monkeypatch)
