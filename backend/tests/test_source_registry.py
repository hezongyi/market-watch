"""Source acquisition identity stays independent of derived day boundaries."""

import importlib.util
from pathlib import Path

import pytest
from alerts import api
from alerts.source_registry import collection_identity, platform_identity, source_report
from alerts.storage import DatasetSource, MarketDemand, SourceSeries
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from test_market_contracts import identity
from test_market_datasets import register


def oanda(**changes):
    return identity(source="oanda", channel="v20", environment="practice",
                    provider_symbol="EUR_USD", account_scope="sha256:" + "a" * 64, **changes)


def migration():
    path = Path(__file__).resolve().parents[2] / "migrations/versions/y26_source_series.py"
    spec = importlib.util.spec_from_file_location("source_series_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_two_day_boundaries_share_collection_but_keep_old_ids(database):
    with database.begin() as db:
        first = register(db)
        second = register(db, identity(calendar_version="utc0-v1"))
        assert first.id != second.id
        assert db.scalar(select(func.count()).select_from(SourceSeries)) == 1
        assert db.scalar(select(func.count()).select_from(DatasetSource)) == 2
        report = source_report(db, identity().key)
        assert report["dataset_ids"] == sorted([identity().key, identity(calendar_version="utc0-v1").key])
        assert "calendar_version" not in report["identity"]


@pytest.mark.parametrize("changes", [
    {"account_scope": "sha256:" + "b" * 64}, {"provider_symbol": "XAU_USD"},
])
def test_account_and_product_do_not_share_acquisition(changes):
    old = oanda()
    new = old.model_copy(update=changes)
    assert collection_identity(old).key != collection_identity(new).key


@pytest.mark.parametrize("changes", [
    {"channel": "rest"}, {"environment": "live"}, {"basis": "mid"},
])
def test_unknown_source_semantics_cannot_be_guessed(changes):
    with pytest.raises(ValueError, match="尚未验证"):
        collection_identity(oanda().model_copy(update=changes))


@pytest.mark.parametrize("parameters", [
    {"timeframe": "H4"}, {"timeframe": "D1", "daily_alignment": 0},
    {"timeframe": "D1", "alignment_timezone": "UTC"},
    {"timeframe": "D1", "weekly_alignment": "Monday"},
])
def test_native_alignment_parameters_separate_cache_identity(parameters):
    assert platform_identity(oanda(), timeframe="D1").key != platform_identity(oanda(), **parameters).key


def test_unknown_legacy_retained_and_known_links_are_immutable(database):
    with database.begin() as db:
        register(db, identity(channel="node"))
        assert source_report(db, identity(channel="node").key) == {
            "status": "unmapped_legacy", "source_id": None}
        register(db)
    with pytest.raises(ValueError, match="immutable"):
        with database.begin() as db:
            db.get(DatasetSource, identity().key).source_id = "other"
    with pytest.raises(ValueError, match="removed"):
        with database.begin() as db:
            db.delete(db.get(SourceSeries, collection_identity(identity()).key))


def test_management_reads_are_authenticated_and_do_not_create_demand(database):
    with database.begin() as db:
        register(db)
    with TestClient(api.app) as client:
        assert client.get("/api/market-data/sources").status_code == 401
        api.app.dependency_overrides[api.authenticated] = lambda: "test"
        try:
            for _ in range(2):
                sources = client.get("/api/market-data/sources").json()
                assert next(s for s in sources if s["source"] == "dukascopy")["native_status"] == "supported"
                report = client.get(f"/api/market-data/datasets/{identity().key}/source")
                assert report.status_code == 200
                assert report.json()["source_id"] == collection_identity(identity()).key
            assert client.get("/api/market-data/datasets/missing/source").status_code == 404
        finally:
            api.app.dependency_overrides.clear()
    with database.begin() as db:
        assert db.scalar(select(MarketDemand)) is None
        assert db.scalar(select(func.count()).select_from(SourceSeries)) == 1


def test_migration_normalization_is_frozen_and_matches_known_identity():
    m = migration()
    for old in (identity(), oanda(), identity(source="binance", channel="rest",
            environment="public", basis="last", provider_symbol="BTCUSDT")):
        current = collection_identity(old)
        assert m.legacy_source(old.model_dump()) == (current.key, current.model_dump())
    assert m.legacy_source(identity(channel="node").model_dump()) is None
    assert m.legacy_source({}) is None
