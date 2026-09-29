from alerts import api as api_module
from fastapi.testclient import TestClient


def test_isolated_store_and_revision(database):
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            old = client.post("/api/charts/workspaces", json={"name": "legacy"}).json()
            new = client.post("/api/advanced-charts/workspaces", json={"name": "new"}).json()
            assert new["id"] not in [x["id"] for x in client.get("/api/charts/workspaces").json()]
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
            assert len(client.get("/api/charts/workspaces").json()) == 1
    finally:
        api_module.app.dependency_overrides.clear()


def test_auth_required(database):
    with TestClient(api_module.app) as client:
        assert client.get("/api/advanced-charts/workspaces").status_code == 401
