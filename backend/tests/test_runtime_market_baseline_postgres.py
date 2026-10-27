"""Verify the fixture's coherent commit with an independent PostgreSQL reader."""

import os

import pytest
from test_provider_postgres import provider_pg as _provider_pg
from test_runtime_market_baseline import test_source_quote_has_one_coherent_commit as contract

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"),
                                reason="Requires isolated Ubuntu PostgreSQL")


def test_source_quote_has_one_coherent_postgres_commit(provider_pg, monkeypatch):
    contract(provider_pg[0], monkeypatch)
