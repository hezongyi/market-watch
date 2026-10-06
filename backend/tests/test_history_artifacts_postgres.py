"""Immutable period artifacts and data-center queries on real PostgreSQL."""

import os

import pytest
import test_data_center as center
import test_history_artifacts as artifacts
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"),
                               reason="Requires isolated Ubuntu PostgreSQL")


@pytest.mark.parametrize("contract", [
    artifacts.test_m1_publication_does_not_claim_other_frames_ready,
    artifacts.test_large_bucket_build_resumes_without_holding_all_minutes,
    artifacts.test_published_artifacts_and_blocks_are_immutable,
    center.test_dataset_available_only_after_period_publication_and_pause_keeps_it,
    center.test_server_pagination_and_literal_filters,
], ids=lambda contract: contract.__name__)
def test_postgres_period_and_center_contract(provider_pg, contract):
    factory, _ = provider_pg
    contract(factory)
