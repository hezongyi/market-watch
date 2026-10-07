"""Actual PostgreSQL fixed chart pagination, HTTP use and ownership isolation."""

import os

import pytest
import test_composite_api as api_contracts
import test_composite_chart as contracts
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated Ubuntu PostgreSQL")


@pytest.mark.parametrize("contract", [
    contracts.test_latest_first_exclusive_pages_return_ascending_fixed_input_without_m1_rescan,
    contracts.test_week_seam_is_aggregated_from_stitched_m1_not_concatenated_daily_bars,
    contracts.test_older_input_page_does_not_include_newer_confirmations,
    contracts.test_sparse_tail_preserves_history_only_seam_bucket_and_exclusive_cursor,
    contracts.test_sparse_months_page_with_bounded_partitions_and_no_duplicate_buckets,
    contracts.test_pending_artifact_is_disclosed_without_mutating_or_switching_baseline,
    api_contracts.test_mapping_candidate_first_use_and_chart_api,
    api_contracts.test_candidate_requires_history_before_day_seam_without_creating_demand,
])
def test_postgres_composite_chart(provider_pg, monkeypatch, contract):
    contract(provider_pg[0], monkeypatch)
