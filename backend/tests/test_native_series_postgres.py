"""Configured native identity survives concurrency on actual isolated PostgreSQL."""

import os
from concurrent.futures import ThreadPoolExecutor

import pytest
from alerts import native_series, provider_cache
from alerts.storage import MarketCatalog, MarketDemand, ProviderDataset, SourceSeries
from sqlalchemy import func, select
from test_provider_postgres import provider_pg as provider_pg

pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated Ubuntu PostgreSQL")


def test_concurrent_registration_has_one_identity_and_separate_caches(provider_pg):
    factory, _ = provider_pg
    with factory.begin() as db:
        db.add(MarketCatalog(id="OANDA:EUR_USD", source="oanda", symbol="EUR_USD", label="EURUSD",
            calendar="ny17", asset_type="CURRENCY", precision=5, available=True, metadata_json={}, updated_at=0))
    from alerts.provider_chart import metadata
    meta = metadata("OANDA:EUR_USD")
    values = {**native_series.DEFAULTS, "price": "A", "smooth": True}
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: native_series.register(meta, values), range(8)))
    assert len({row["id"] for row in results}) == 1
    custom_key = provider_cache.ensure(results[0], "D1")
    original_key = provider_cache.ensure(meta, "D1")
    assert custom_key != original_key
    with factory.begin() as db:
        assert db.scalar(select(func.count()).select_from(SourceSeries)) == 1
        assert db.get(ProviderDataset, custom_key).metadata_json["native_parameters"] == values
        assert db.get(ProviderDataset, custom_key).metadata_json["native_period_identity"]["parameters"] == {**values, "granularity": "D"}
        assert db.get(ProviderDataset, original_key).metadata_json["native_parameters"] == native_series.DEFAULTS
        assert db.scalar(select(func.count()).select_from(MarketDemand)) == 0
