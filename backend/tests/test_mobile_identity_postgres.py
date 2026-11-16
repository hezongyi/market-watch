"""Source/price expansion against the actual PostgreSQL query planner."""

import os

import pytest
from test_mobile_identity import (
    test_price_aliases_filter_expanded_series_without_losing_page_members as price_pages,
)
from test_mobile_identity import (
    test_upstream_aliases_qualify_native_variants_before_pagination as upstream_pages,
)
from test_provider_postgres import provider_pg as provider_pg

pytestmark = pytest.mark.skipif(
    not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated Ubuntu PostgreSQL"
)


def test_upstream_pages(provider_pg, monkeypatch):
    upstream_pages(provider_pg[0], monkeypatch)


def test_price_pages(provider_pg, monkeypatch):
    price_pages(provider_pg[0], monkeypatch)
