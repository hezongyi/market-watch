from alerts import api as api_module
from fastapi.testclient import TestClient


def test_shared_templates_revision_and_namespace(database):
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            body = {
                "kind": "drawing",
                "name": "默认",
                "tool": "trend_line",
                "content": {"value": "opaque"},
            }
            first = client.post("/api/advanced-charts/preferences/save", json=body)
            assert first.status_code == 200
            row = first.json()
            assert row["revision"] == 1
            assert (
                client.post("/api/advanced-charts/preferences/save", json=body).status_code == 409
            )
            second = client.post(
                "/api/advanced-charts/preferences/save", json={**body, "tool": "ray"}
            )
            assert second.status_code == 200 and second.json()["id"] != row["id"]
            assert len(client.get("/api/advanced-charts/preferences").json()) == 2
            assert (
                client.post(
                    "/api/advanced-charts/preferences/save",
                    json={**body, "revision": 1, "content": {"value": "updated"}},
                ).json()["revision"]
                == 2
            )
            assert (
                client.post(
                    "/api/advanced-charts/preferences/" + row["id"] + "/delete",
                    json={"revision": 1},
                ).status_code
                == 409
            )
            assert (
                client.post(
                    "/api/advanced-charts/preferences/" + row["id"] + "/delete",
                    json={"revision": 2},
                ).status_code
                == 200
            )
            assert (
                client.post(
                    "/api/advanced-charts/preferences/save", json={**body, "revision": 2}
                ).status_code
                == 409
            )
            assert client.get("/api/charts/templates").json() == []
    finally:
        api_module.app.dependency_overrides.clear()


def test_legacy_migration_preserves_conflicts_and_does_not_resurrect(database):
    from alerts.advanced_api import migrate_legacy_templates
    from alerts.storage import AdvancedPreference, AdvancedWorkspace
    from sqlalchemy import select

    with database.begin() as db:
        db.add_all(
            [
                AdvancedWorkspace(id="a", name="A", document={"templates": {"EMA": "first"}}),
                AdvancedWorkspace(id="b", name="B", document={"templates": {"EMA": "second"}}),
                AdvancedWorkspace(id="c", name="C", document={"templates": {"EMA": "first"}}),
            ]
        )
    with database.begin() as db:
        migrate_legacy_templates(db)
        rows = list(db.scalars(select(AdvancedPreference)))
        assert len(rows) == 2
        assert {r.content["value"] for r in rows} == {"first", "second"}
        assert db.get(AdvancedWorkspace, "a").document == {"templates": {"EMA": "first"}}
        for row in rows:
            db.delete(row)
    with database.begin() as db:
        migrate_legacy_templates(db)
        assert list(db.scalars(select(AdvancedPreference))) == []
