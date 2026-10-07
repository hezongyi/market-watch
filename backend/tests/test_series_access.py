"""Business charts preserve identities, snapshots and first-use boundaries."""

import csv
import io
import json

import pytest
from alerts import api
from alerts.chart_api import DataQuery, checked, data_sync
from alerts.chart_series import decode, encode
from alerts.composite_definitions import save_mapping
from alerts.history_retention import lock_reference_values, references
from alerts.series_access import metadata, search
from alerts.storage import AdvancedWorkspace, CompositeRevision, MarketComposite, MarketDemand
from fastapi.testclient import TestClient
from sqlalchemy import select
from test_composite_definitions import PROOF, prepare, publish
from test_market_contracts import identity


def fixture(database, monkeypatch):
    catalog = prepare(database, monkeypatch)
    parent = publish(database)
    monkeypatch.setattr("alerts.composite_definitions.now_ms", lambda: 165725000)
    with database.begin() as db:
        save_mapping(db, identity().key, catalog, PROOF)
    return parent


def test_explicit_kinds_retain_legacy_and_reject_forged_prefixes():
    assert decode("EURUSD") == ("EURUSD", "managed")
    assert decode("MD:" + "a" * 25 + ":EURUSD")[1] == "managed"
    for symbol, kind in [("a" * 64, "composite"), ("12345678-1234-1234-1234-123456789abc", "history")]:
        assert decode(encode(symbol, kind)) == (symbol, kind)
        assert decode(encode(symbol, kind).upper()) == (symbol, kind)
    with pytest.raises(ValueError):
        decode("MWH:EURUSD")
    with pytest.raises(ValueError):
        encode("MWP:EURUSD", "managed")


def test_search_resolve_watchlist_are_pure_and_first_data_read_is_idempotent(database, monkeypatch):
    parent = fixture(database, monkeypatch)
    api.app.dependency_overrides[api.authenticated] = lambda: "test"
    try:
        with TestClient(api.app) as client:
            rows = client.get("/api/market-data/series/search?query=EURUSD&kind=composite").json()
            assert len(rows) == 1 and rows[0]["created"] is False
            row = rows[0]
            native = client.get("/api/market-data/series/search?query=EUR&kind=provider").json()
            assert any(item["ticker"] == "MWP:OANDA:EUR_USD" for item in native)
            assert not any(item["id"].startswith("MD:") for item in native)
            resolved = client.post("/api/market-data/resolve", json={"instrument": row["id"],
                "series_kind": "composite", "timeframe": "M1"})
            assert resolved.status_code == 200 and resolved.json()["history_version_id"] == parent
            quotes = client.post("/api/market-data/quotes", json={"symbols": [row["ticker"], encode(parent, "history")]})
            assert quotes.status_code == 200 and all(q["s"] == "ok" for q in quotes.json())
            client.post("/api/market-data/activity", json={"instrument": row["ticker"], "client": "test-chart"})
            with database.begin() as db:
                assert db.scalar(select(MarketComposite)) is None and db.scalar(select(MarketDemand)) is None
            for _ in range(2):
                response = client.post("/api/charts/data", json={"instrument": row["id"],
                    "series_kind": "composite", "timeframe": "M1", "before": 165600000,
                    "limit": 2, "client": "test-chart"})
                assert response.status_code == 200, response.text
                assert len(response.json()["bars"]) == 2
            with database.begin() as db:
                assert len(list(db.scalars(select(MarketComposite)))) == 1
                assert len(list(db.scalars(select(MarketDemand)))) == 1
                composite = db.scalar(select(MarketComposite))
                assert db.get(CompositeRevision, composite.active_revision_id).history_version_id == parent
    finally:
        api.app.dependency_overrides.clear()


def test_fixed_history_stays_on_version_after_daily_head_and_retains_workspace_reference(database, monkeypatch):
    parent = fixture(database, monkeypatch)
    ticker = encode(parent, "history")
    publish(database, end=259320000)
    page = data_sync(DataQuery(instrument=ticker, timeframe="M1", limit=2, client="history-chart"))
    assert page["version_id"] == parent
    with database.begin() as db:
        assert db.scalar(select(MarketDemand)) is None and db.scalar(select(MarketComposite)) is None
        db.add(AdvancedWorkspace(name="fixed history", document={"symbol": ticker.upper()}))
    with database.begin() as db:
        assert any(item["kind"] == "workspace" for item in references(db, identity().key)["items"])
        assert metadata(db, parent, "history")["history_version_id"] == parent
        assert search(db, "EURUSD", kind="history")[0]["id"] != parent
    document = {"schemaVersion": 1, "layout": "1", "panels": [
        {"id": "fixed", "instrument": ticker, "timeframe": "M1", "indicators": []}], "drawings": {}}
    checked(document)
    with database.begin() as db:
        with pytest.raises(ValueError, match="不存在"):
            lock_reference_values(db, {"symbol": "MWH:ffffffff-ffff-ffff-ffff-ffffffffffff"})


def test_fixed_chart_never_silently_computes_indicator_on_page_prefix(database, monkeypatch):
    from alerts.fixed_indicators import indicator_tick

    parent = fixture(database, monkeypatch)
    query = DataQuery(instrument=parent, series_kind="history", timeframe="M1", limit=2,
        indicators=[{"name": "SMA", "version": "1", "params": {"period": 2}}])
    page = data_sync(query)
    assert page["pending"] and page["indicators"][0]["series"][0]["values"] == []
    run_id = page["indicator_progress"][0]["run_id"]
    while indicator_tick(run_id):
        pass
    page = data_sync(query)
    assert not page["pending"] and page["indicator_progress"][0]["status"] == "complete"
    assert [value["time"] for value in page["indicators"][0]["series"][0]["values"]] == [
        bar["start"] for bar in page["bars"]]


def test_fixed_export_uses_original_version_and_composite_snapshot_without_demand(database, monkeypatch):
    from alerts.composite_definitions import first_use
    from alerts.storage import RealtimeMapping

    parent = fixture(database, monkeypatch)
    publish(database, end=259320000)
    api.app.dependency_overrides[api.authenticated] = lambda: "test"
    try:
        with TestClient(api.app) as client:
            query = {"instrument": encode(parent, "history").upper(), "timeframe": "M1",
                     "start": 0, "end": 172920000, "published": True}
            response = client.post("/api/charts/export", json=query)
            assert response.status_code == 200, response.text
            rows = list(csv.DictReader(io.StringIO(response.content.decode("utf-8-sig"))))
            assert len(rows) == 4
            assert {row["history_version_id"] for row in rows} == {parent}
            assert rows[-1]["start_ms"] == "172860000"
            with database.begin() as db:
                assert db.scalar(select(MarketDemand)) is None
                candidate = search(db, "EURUSD", kind="composite")[0]
            rejected = client.post("/api/charts/export", json={**query, "instrument": candidate["ticker"]})
            assert rejected.status_code == 422 and "尚未建立" in rejected.json()["detail"]
            with database.begin() as db:
                assert db.scalar(select(MarketComposite)) is None
                mapping = db.scalar(select(RealtimeMapping))
                composite = first_use(db, mapping.dataset_id, mapping.id)
                revision = composite.active_revision_id
            response = client.post("/api/charts/export", json={**query, "instrument": candidate["ticker"],
                "end": 165600000, "composite_revision_id": revision, "input_revision": 0})
            assert response.status_code == 200, response.text
            rows = list(csv.DictReader(io.StringIO(response.content.decode("utf-8-sig"))))
            assert len(rows) == 2
            assert {row["composite_revision_id"] for row in rows} == {revision}
            assert {row["input_revision"] for row in rows} == {"0"}
            assert all(json.loads(row["segments"])[0]["segment"] == "history" for row in rows)
            with database.begin() as db:
                assert db.scalar(select(MarketDemand)) is None
            wrong = client.post("/api/charts/export", json={**query, "series_kind": "provider"})
            assert wrong.status_code == 422 and "类型不一致" in wrong.json()["detail"]
    finally:
        api.app.dependency_overrides.clear()


def test_fixed_export_rejects_actual_row_overflow_without_import_jobs(database, monkeypatch):
    from alerts.history_artifacts import artifact_tick
    from alerts.history_versions import create_version, import_page
    from alerts.storage import ImportJob
    from test_history_versions import Adapter
    from test_market_contracts import batch, minute

    prepare(database, monkeypatch)
    end = 2001 * 60000
    with database.begin() as db:
        parent = create_version(db, identity().key, 0, end)
    import_page(Adapter([batch(window_end=end, checkpoint=end,
        rows=tuple(minute(at) for at in range(0, end, 60000)))]), version_id=parent)
    while artifact_tick(parent):
        pass
    api.app.dependency_overrides[api.authenticated] = lambda: "test"
    try:
        with TestClient(api.app) as client:
            query = {"instrument": parent, "series_kind": "history", "timeframe": "M1", "start": 0, "end": end}
            assert client.post("/api/charts/export", json=query).status_code == 413
            valid = client.post("/api/charts/export", json={**query, "start": 60000})
            assert valid.status_code == 200, valid.text
            assert len(list(csv.DictReader(io.StringIO(valid.content.decode("utf-8-sig"))))) == 2000
            with database.begin() as db:
                assert db.scalar(select(ImportJob)) is None and db.scalar(select(MarketDemand)) is None
    finally:
        api.app.dependency_overrides.clear()
