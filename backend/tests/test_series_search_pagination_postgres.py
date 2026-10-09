"""Actual SQL pagination in a disposable schema, never the live acceptance data."""

import os

import pytest
from test_provider_postgres import provider_pg as provider_pg
from test_series_search_pagination import (
    test_all_cursor_covers_each_kind_filters_before_paging_and_rejects_changed_query as all_cursor,
    test_composite_pages_use_known_mapping_without_scanning_other_products as composite_pages,
)
from test_series_search_pagination import (
    test_large_history_pages_no_duplicates_loss_or_source_starvation as large_pages,
)
from test_series_search_pagination import (
    test_latest_usable_artifact_skips_unpublished_and_reclaimed_versions as latest_version,
)
from test_series_search_pagination import (
    test_page_reads_only_selected_metadata_and_http_is_authenticated as bounded_queries,
)

pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated Ubuntu PostgreSQL")


def test_large_catalog_fair_pages(provider_pg):
    large_pages(provider_pg[0])


def test_unavailable_versions_and_archived_dataset(provider_pg):
    latest_version(provider_pg[0])


def test_sql_cost_and_authenticated_page(provider_pg):
    bounded_queries(provider_pg[0])


def test_composite_mapping_pages_and_active_revision_calendar(provider_pg, monkeypatch):
    composite_pages(provider_pg[0], monkeypatch)


def test_all_kind_cursor_and_asset_filter(provider_pg, monkeypatch):
    all_cursor(provider_pg[0], monkeypatch)
