"""Draft checks must remain read-only and create-only commits must protect plans."""

import pytest
from alerts import api, history_creation_check
from alerts.history_api import CreationCheckRequest
from alerts.history_catalog import account_scope
from alerts.history_creation_check import check_creation, search_catalog
from alerts.storage import (
    DatasetMaintenance,
    HistoryRun,
    HistoryVersion,
    MarketCatalog,
    MarketDataset,
    MarketDemand,
    SourceSeries,
)
from fastapi.testclient import TestClient
from sqlalchemy import func, select


def draft(**changes):
    return {
        "source": "dukascopy",
        "provider_symbol": "EUR/USD",
        "logical_symbol": "EURUSD",
        "asset_class": "forex",
        "precision": 5,
        "aggregation_calendar": "ny17",
        "start_date": "2026-07-06",
        **changes,
    }


def test_combined_catalog_filters_paging_scope_and_no_registration(database, monkeypatch):
    monkeypatch.setattr(
        history_creation_check.settings, "oanda_account_id", "creation-test-account"
    )
    monkeypatch.setattr(history_creation_check.settings, "oanda_token", "test-only")
    with database.begin() as db:
        db.add(
            MarketCatalog(
                id="HC:" + "a" * 36,
                source="oanda",
                symbol="EUR_USD",
                label="Euro",
                asset_type="CURRENCY",
                precision=5,
                calendar="ny17",
                metadata_json={"history_account_scope": account_scope()},
            )
        )
        db.flush()
        all_rows = search_catalog(db, query="EURUSD", limit=1)
        next_rows = search_catalog(db, query="EURUSD", offset=1, limit=1)
        assert all_rows["total"] == 2 and len(next_rows["items"]) == 1
        assert all_rows["items"][0]["catalog_id"] != next_rows["items"][0]["catalog_id"]
        assert {all_rows["items"][0]["source"], next_rows["items"][0]["source"]} == {
            "dukascopy",
            "oanda",
        }
        assert search_catalog(db, source="oanda", query="EURUSD")["items"][0]["precision"] == 5
        assert search_catalog(db, symbol_type="commodity", query="EURUSD")["total"] == 0
        assert (
            search_catalog(db, source="oanda", query="NO-MATCH")["sources"][0]["requires_refresh"]
            is False
        )
        for table in (MarketDataset, HistoryVersion, HistoryRun, MarketDemand, SourceSeries):
            assert db.scalar(select(func.count()).select_from(table)) == 0
        with pytest.raises(ValueError):
            search_catalog(db, source="binance")
    monkeypatch.setattr(history_creation_check.settings, "oanda_account_id", "other-account")
    with database.begin() as db:
        assert search_catalog(db, source="oanda")["total"] == 0
        assert search_catalog(db, source="oanda")["sources"][0]["requires_refresh"] is True


def test_precision_date_and_catalog_check_stay_read_only(database):
    with database.begin() as db:
        row = search_catalog(db, source="dukascopy", query="EURUSD")["items"][0]
        check = check_creation(db, draft(catalog_id=row["catalog_id"]))
        assert check["status"] == "ready" and check["start"] == 1783285200000
        assert check_creation(db, draft(aggregation_calendar=None))["start"] == check["start"]
        assert check_creation(db, draft(aggregation_calendar="utc0"))["start"] == 1783296000000
        assert check_creation(db, draft(precision=None))["status"] == "precision_required"
        assert check_creation(db, draft(start_date=None))["start"] is None
        with pytest.raises(ValueError, match="历史起点"):
            check_creation(db, draft(start_date="2999-01-01"))
        with pytest.raises(ValueError, match="日期"):
            check_creation(db, draft(start_date="not-a-date"))
        with pytest.raises(ValueError, match="目录"):
            check_creation(db, draft(catalog_id=row["catalog_id"], logical_symbol="GBPUSD"))
        assert db.scalar(select(MarketDataset)) is None and db.scalar(select(MarketDemand)) is None
        assert db.scalar(select(SourceSeries)) is None


def test_unconfigured_connection_and_account_precision(database, monkeypatch):
    monkeypatch.setattr(history_creation_check.settings, "oanda_token", "")
    with database.begin() as db:
        assert (
            check_creation(db, draft(source="oanda", provider_symbol="EUR_USD"))["status"]
            == "connection_required"
        )
    monkeypatch.setattr(history_creation_check.settings, "oanda_account_id", "creation-account")
    monkeypatch.setattr(history_creation_check.settings, "oanda_token", "test-only")
    with database.begin() as db:
        db.add(
            MarketCatalog(
                id="HC:" + "b" * 36,
                source="oanda",
                symbol="EUR_USD",
                label="Euro",
                asset_type="CURRENCY",
                precision=5,
                calendar="ny17",
                metadata_json={"history_account_scope": account_scope()},
            )
        )
        db.flush()
        with pytest.raises(ValueError, match="精度"):
            check_creation(
                db,
                draft(
                    source="oanda",
                    provider_symbol="EUR_USD",
                    precision=3,
                    catalog_id="HC:" + "b" * 36,
                ),
            )


def test_preflight_race_cannot_overwrite_plan_and_idempotency_still_works(database):
    api.app.dependency_overrides[api.authenticated] = lambda: "test"
    body = {
        "request_id": "create-only-1",
        "create_only": True,
        "dataset": CreationCheckRequest(**draft()).model_dump(exclude={"start_date"}),
        "maintenance": {"target_start": 0, "timeframes": ["M1", "H4"]},
    }
    try:
        with TestClient(api.app) as client:
            invalid = client.post(
                "/api/market-data/center/datasets/check", json=draft(start_date="2999-01-01")
            ).json()
            assert invalid["status"] == "invalid" and invalid["field"] == "create-day"
            assert (
                client.post("/api/market-data/center/datasets/check", json=draft()).json()["status"]
                == "ready"
            )
            created = client.post("/api/market-data/center/datasets", json=body)
            assert created.status_code == 201
            ident = created.json()["dataset"]["id"]
            with database.begin() as db:
                before = db.get(DatasetMaintenance, ident).timeframes
            refused = client.post(
                "/api/market-data/center/datasets",
                json={
                    **body,
                    "request_id": "create-only-2",
                    "maintenance": {"target_start": 60000, "timeframes": ["M1", "D1"]},
                },
            )
            assert refused.status_code == 409 and refused.json()["detail"]["dataset_id"] == ident
            again = client.post("/api/market-data/center/datasets", json=body)
            assert (
                again.status_code == 201
                and again.json()["task"]["id"] == created.json()["task"]["id"]
            )
            checked = client.post("/api/market-data/center/datasets/check", json=draft()).json()
            assert checked["status"] == "existing" and checked["existing"]["id"] == ident
            assert (
                client.post(
                    "/api/market-data/center/datasets/check",
                    json=draft(aggregation_calendar="utc0"),
                ).json()["status"]
                == "ready"
            )
            assert (
                client.get("/api/market-data/history-catalog/search?source=yahoo").status_code
                == 422
            )
            with database.begin() as db:
                assert db.get(DatasetMaintenance, ident).timeframes == before
                assert db.scalar(select(func.count()).select_from(HistoryRun)) == 1
                assert db.scalar(select(MarketDemand)) is None
    finally:
        api.app.dependency_overrides.clear()
