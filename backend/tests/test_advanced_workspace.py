from alerts import api as api_module
from fastapi.testclient import TestClient


def test_isolated_store_and_revision(database):
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            from alerts.storage import ChartWorkspace
            with database.begin() as db:
                archived = ChartWorkspace(name="legacy", document={"schemaVersion": 1, "panels": []})
                db.add(archived)
                db.flush()
                old = {"id": archived.id}
            assert client.post("/api/charts/workspaces", json={"name": "legacy"}).status_code == 410
            new = client.post("/api/advanced-charts/workspaces", json={"name": "new"}).json()
            assert client.get("/api/charts/workspaces").status_code == 410
            assert old["id"] not in [
                x["id"] for x in client.get("/api/advanced-charts/workspaces").json()
            ]
            body = {
                "name": "saved",
                "revision": 1,
                "document": {"engine": "tv31", "schemaVersion": 1, "state": {"charts": []}},
            }
            assert (
                client.post(
                    f"/api/advanced-charts/workspaces/{old['id']}/save", json=body
                ).status_code
                == 409
            )
            assert (
                client.post(
                    f"/api/advanced-charts/workspaces/{new['id']}/save", json=body
                ).status_code
                == 200
            )
            assert (
                client.post(
                    f"/api/advanced-charts/workspaces/{new['id']}/save", json=body
                ).status_code
                == 409
            )
            body["revision"] = 2
            body["document"] = {"schemaVersion": 1}
            assert (
                client.post(
                    f"/api/advanced-charts/workspaces/{new['id']}/save", json=body
                ).status_code
                == 422
            )
            assert (
                client.post(
                    f"/api/advanced-charts/workspaces/{new['id']}/delete", json={"revision": 1}
                ).status_code
                == 409
            )
            assert (
                client.post(
                    f"/api/advanced-charts/workspaces/{new['id']}/delete", json={"revision": 2}
                ).status_code
                == 200
            )
            with database() as db:
                assert db.get(ChartWorkspace, old["id"]).document == {"schemaVersion": 1, "panels": []}
    finally:
        api_module.app.dependency_overrides.clear()


def test_auth_required(database):
    with TestClient(api_module.app) as client:
        assert client.get("/api/advanced-charts/workspaces").status_code == 401


def test_native_save_load_copy_and_legacy_revision_conflict(database):
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            original = client.post(
                "/api/advanced-charts/workspaces", json={"name": "原工作区"}
            ).json()
            payload = {
                "id": original["id"],
                "name": "原生保存",
                "symbol": "EURUSD",
                "resolution": "60",
                "content": '{"charts":[]}',
                "revision": original["revision"],
            }
            saved = client.post("/api/advanced-charts/native-charts/save", json=payload)
            assert saved.status_code == 200
            row = saved.json()
            assert row["revision"] == 2 and row["document"]["engine"] == "tv31"
            listing = client.get("/api/advanced-charts/native-charts").json()
            assert listing[0]["symbol"] == "EURUSD" and listing[0]["resolution"] == "60"
            loaded = client.get("/api/advanced-charts/native-charts/" + row["id"]).json()
            import json

            assert json.loads(loaded["content"]) == {"charts": []}
            assert (
                client.post("/api/advanced-charts/native-charts/save", json=payload).status_code
                == 409
            )
            assert (
                client.post(
                    "/api/advanced-charts/workspaces/" + row["id"] + "/save",
                    json={"name": "stale", "revision": 1, "document": original["document"]},
                ).status_code
                == 409
            )
            duplicate = client.post(
                "/api/advanced-charts/native-charts/save",
                json={**payload, "id": None, "revision": 0, "name": "副本"},
            ).json()
            assert duplicate["id"] != row["id"]
            assert len(client.get("/api/advanced-charts/native-charts").json()) == 2
            assert client.get("/api/charts/workspaces").status_code == 410
            assert (
                client.post(
                    "/api/advanced-charts/native-charts/save", json={**payload, "content": "[]"}
                ).status_code
                == 422
            )
            assert (
                client.post(
                    "/api/advanced-charts/native-charts/save",
                    json={**payload, "content": '{"x":NaN}'},
                ).status_code
                == 422
            )
    finally:
        api_module.app.dependency_overrides.clear()
