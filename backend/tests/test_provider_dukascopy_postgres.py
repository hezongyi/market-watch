"""Exact native prices and cache isolation over real PostgreSQL HTTP calls."""

import os

import pytest
from test_provider_dukascopy import native_http_contract
from test_provider_postgres import provider_pg  # noqa: F401

pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated PostgreSQL")


def test_native_http_cache_exact_decimals_and_no_managed_side_effects(provider_pg, monkeypatch):  # noqa: F811
    factory, _ = provider_pg
    native_http_contract(factory, monkeypatch)
