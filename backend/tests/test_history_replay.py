from alerts import api as api_module
from alerts.history_replay import create_replay
from alerts.history_versions import import_page
from alerts.storage import Replay
from fastapi.testclient import TestClient
from test_history_versions import Adapter, create
from test_market_contracts import batch, minute


def test_pinned_replay_inputs_and_manifest_survive_new_history_version(database):
    first, instrument = create(database)
    import_page(Adapter([batch(checkpoint=120000)]), version_id=first)
    with database.begin() as db:
        from alerts.storage import Instrument

        run = create_replay(db, db.get(Instrument, instrument), first, "M1", 0, 120000)
        saved, original = run.id, run.bars
        manifest = run.input_manifest
    second, _ = create(database)
    import_page(Adapter([batch(rows=(minute(close="1.10"), minute(60000, close="1.10")),
                              observed_at=185000, checkpoint=120000)]), version_id=second)
    with database.begin() as db:
        run = db.get(Replay, saved)
        assert run.dataset_version == first
        assert run.bars == original and run.input_manifest == manifest


def test_api_requires_explicit_version_and_seek_preserves_source_provenance(database):
    first, instrument = create(database)
    import_page(Adapter([batch(checkpoint=120000)]), version_id=first)
    body = {"instrument_id": instrument, "timeframe": "M1", "start": 0, "end": 120000}
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            assert client.post("/api/replays", json=body).status_code == 422
            response = client.post("/api/replays", json=body | {"dataset_version": first})
            assert response.status_code == 201
            replay = response.json()
            assert replay["dataset_version"] == first
            assert replay["input_manifest"]["identity"]["channel"] == "python"
            seek = client.post("/api/replays/" + replay["id"] + "/seek", json={"cursor": 60000})
            assert seek.status_code == 201
            assert seek.json()["input_manifest"] == replay["input_manifest"]
            assert seek.json()["dataset_version"] == first
            watch = client.post("/api/replays/" + replay["id"] + "/watches", json={
                "instrument_id": instrument, "name": "source pinned", "kind": "price",
                "timeframe": "M1", "level": "1.105", "direction": "buy",
            })
            assert watch.status_code == 200
            assert client.get("/api/market-data/versions/" + first).json()["status"] == "published"
            assert client.post("/api/imports", json=body).status_code == 422
    finally:
        api_module.app.dependency_overrides.clear()
