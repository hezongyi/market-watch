"""Defaults, selectable phases and immutable source/replay preservation."""

import json
from datetime import UTC, datetime

import pytest
from alerts import api
from alerts.aggregation_policy import change_aggregation, register_history_dataset, resolve_calendar
from alerts.domain import bucket_bounds, calendar_for
from alerts.history_replay import create_replay
from alerts.history_versions import import_page, snapshot_rows
from alerts.storage import HistoryVersion, Instrument, Replay
from fastapi.testclient import TestClient
from test_history_versions import Adapter, create
from test_market_contracts import batch


@pytest.mark.parametrize("asset_class,expected", [
    ("forex", "ny17"), ("metal", "ny17"), ("crypto", "utc0"),
])
def test_defaults_and_explicit_override(asset_class, expected):
    assert resolve_calendar(asset_class) == expected
    assert resolve_calendar(asset_class, "utc0") == "utc0"
    assert resolve_calendar(asset_class, "ny17") == "ny17"


@pytest.mark.parametrize("asset_class", ["index", "other", "unspecified"])
def test_undecided_classes_require_explicit_phase(asset_class):
    with pytest.raises(ValueError, match="待定"):
        resolve_calendar(asset_class)
    assert resolve_calendar(asset_class, "ny17") == "ny17"
    with pytest.raises(ValueError):
        resolve_calendar(asset_class, "utc8")


def test_api_registers_crypto_utc_and_keeps_index_undecided(database):
    api.app.dependency_overrides[api.authenticated] = lambda: "test"
    try:
        with TestClient(api.app) as client:
            body = {"logical_symbol": "BTCUSD", "provider_symbol": "BTC/USD",
                    "asset_class": "crypto", "precision": 3}
            row = client.post("/api/market-data/datasets", json=body)
            assert row.status_code == 201
            assert row.json()["aggregation_calendar"] == "utc0"
            assert row.json()["asset_class"] == "crypto"
            assert client.post("/api/market-data/datasets", json=body).json()["id"] == row.json()["id"]
            index = body | {"logical_symbol": "US500", "provider_symbol": "USA500.IDX/USD",
                            "asset_class": "index"}
            # Provider codes allow dots used by index symbols.
            rejected = client.post("/api/market-data/datasets", json=index)
            assert rejected.status_code == 422 and "待定" in rejected.text
            index["aggregation_calendar"] = "utc0"
            assert client.post("/api/market-data/datasets", json=index).status_code == 201
            options = client.get("/api/market-data/aggregation-options").json()
            assert "index" not in options["defaults"]
            assert "index" in options["unresolved_asset_classes"]
    finally:
        api.app.dependency_overrides.clear()


def test_changed_phase_reuses_original_m1_and_preserves_pinned_replay(database):
    parent, old_inst = create(database)
    import_page(Adapter([batch(checkpoint=120000)]), version_id=parent)
    with database.begin() as db:
        original = db.get(HistoryVersion, parent)
        source = original.dataset_id
        before = json.dumps(original.manifest, sort_keys=True)
        replay = create_replay(db, db.get(Instrument, old_inst), parent, "M1", 0, 120000)
        replay_id = replay.id
        replay_before = json.dumps(replay.input_manifest, sort_keys=True)
        destination, inst, version = change_aggregation(db, source, "utc0", version_id=parent)
        target, new_inst, derived = destination.id, inst.id, version.id
        assert target != source and old_inst != new_inst
        assert inst.calendar == "utc0" and version.status == "deriving"
        assert change_aggregation(db, source, "utc0", version_id=parent)[2].id == derived
    # Worker handles derived chunks before invoking the network adapter.
    assert import_page(Adapter([]), version_id=derived)
    assert import_page(Adapter([]), version_id=derived)
    with database.begin() as db:
        assert db.get(HistoryVersion, derived).status == "published"
        assert list(snapshot_rows(db, derived)) == list(snapshot_rows(db, parent))
        assert json.dumps(db.get(HistoryVersion, parent).manifest, sort_keys=True) == before
        pinned = db.get(Replay, replay_id)
        assert pinned.dataset_version == parent and pinned.instrument_id == old_inst
        assert json.dumps(pinned.input_manifest, sort_keys=True) == replay_before
        assert db.get(Instrument, old_inst).calendar == "ny17"
        assert db.get(HistoryVersion, derived).manifest["aggregation_calendar"] == "utc0"
        assert change_aggregation(db, source, "utc0", version_id=parent)[2].id == derived
        with pytest.raises(ValueError, match="已发布"):
            change_aggregation(db, source, "utc0", version_id="missing")


@pytest.mark.parametrize("stamp,expected_hour", [("2026-01-06T23:00:00+00:00", 22),
                                                 ("2026-07-06T23:00:00+00:00", 21)])
def test_each_dataset_controls_h4_d1_boundaries(database, stamp, expected_hour):
    moment = datetime.fromisoformat(stamp)
    with database.begin() as db:
        _, forex = register_history_dataset(db, logical_symbol="EURUSD", provider_symbol="EUR/USD",
                                           asset_class="forex", precision=6)
        _, crypto = register_history_dataset(db, logical_symbol="BTCUSD", provider_symbol="BTC/USD",
                                            asset_class="crypto", precision=3)
        assert bucket_bounds(moment, "D1", calendar_for(forex))[0].hour == expected_hour
        assert bucket_bounds(moment, "H4", calendar_for(forex))[0].hour == expected_hour
        assert bucket_bounds(moment, "D1", calendar_for(crypto))[0].hour == 0
        assert bucket_bounds(moment, "H4", calendar_for(crypto))[0].hour == 20
        assert bucket_bounds(moment, "D1", calendar_for(crypto))[0].tzinfo == UTC


def test_configuration_requires_authentication(database):
    # Authentication checked separately without any source data access.
    with TestClient(api.app) as client:
        assert client.post("/api/market-data/datasets", json={}).status_code == 401
        assert client.post("/api/market-data/datasets/unknown/aggregation", json={}).status_code == 401


def test_api_configures_existing_published_history_as_new_identity(database):
    parent, instrument = create(database)
    import_page(Adapter([batch(checkpoint=120000)]), version_id=parent)
    with database.begin() as db:
        source = db.get(HistoryVersion, parent).dataset_id
    api.app.dependency_overrides[api.authenticated] = lambda: "test"
    try:
        with TestClient(api.app) as client:
            path = f"/api/market-data/datasets/{source}/aggregation"
            request = {"aggregation_calendar": "utc0", "version_id": parent}
            response = client.post(path, json=request)
            assert response.status_code == 201
            data = response.json()
            assert data["dataset"]["id"] != source
            assert data["dataset"]["aggregation_calendar"] == "utc0"
            assert data["version"]["status"] == "deriving"
            assert client.post(path, json=request).json()["version"]["id"] == data["version"]["id"]
            assert client.post(path, json=request | {"version_id": "unknown"}).status_code == 422
            assert client.post(path, json=request | {"aggregation_calendar": "utc8"}).status_code == 422
        with database.begin() as db:
            assert db.get(Instrument, instrument).calendar == "ny17"
    finally:
        api.app.dependency_overrides.clear()
