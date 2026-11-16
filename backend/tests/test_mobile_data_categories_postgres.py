"""Run category selection/ranking against an isolated actual PostgreSQL schema."""
import os

import pytest
from test_mobile_data_categories import (
    test_api_category_contract_and_default_desktop_response_stay_compatible as category_api,
)
from test_mobile_data_categories import (
    test_category_filters_all_members_before_ranking_and_facets_ignore_source as category_pages,
)
from test_mobile_data_categories import (
    test_market_groups_match_row_badges_and_never_fold_etf_into_stocks as category_markets,
)
from test_provider_postgres import provider_pg as provider_pg

pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated Ubuntu PostgreSQL")

def test_pages(provider_pg):
    category_pages(provider_pg[0])

def test_markets(provider_pg):
    category_markets(provider_pg[0])

def test_api(provider_pg):
    category_api(provider_pg[0])
