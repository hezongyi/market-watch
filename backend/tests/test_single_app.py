"""Compatibility of versioned flags and exact notification destinations."""

from copy import deepcopy

import pytest
from alerts import api as api_module
from alerts.storage import AdvancedPreference, Notification
from alerts.symbol_flags import validate_flags
from fastapi.testclient import TestClient
from sqlalchemy import select
from test_notify import pending


def test_explicit_workspace_get_isolated_from_legacy_and_missing_ids(database):
    from alerts.storage import AdvancedWorkspace, ChartWorkspace

    with database.begin() as db:
        db.add(
            AdvancedWorkspace(
                id="professional",
                name="Professional",
                document={"engine": "tv31", "schemaVersion": 1},
            )
        )
        db.add(
            ChartWorkspace(id="legacy", name="Legacy", document={"schemaVersion": 1, "panels": []})
        )
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            row = client.get("/api/advanced-charts/workspaces/professional")
            assert row.status_code == 200 and row.json()["document"]["engine"] == "tv31"
            assert client.get("/api/advanced-charts/workspaces/legacy").status_code == 404
            assert client.get("/api/advanced-charts/workspaces/missing").status_code == 404
    finally:
        api_module.app.dependency_overrides.clear()


@pytest.mark.parametrize(
    "value",
    [
        None,
        {},
        {"version": True, "flags": {}},
        {"version": 2, "flags": {}},
        {"version": 1, "flags": []},
        {"version": 1, "flags": {"EURUSD": "orange"}},
        {"version": 1, "flags": {"MWPY_xxx": "red"}},
    ],
)
def test_flags_reject_unknown_formats(value):
    with pytest.raises(ValueError):
        validate_flags({"value": value})


def test_flags_preferences_are_separate_and_revision_guarded(database):
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            old = {
                "kind": "setting",
                "name": "mw.watchlists.v1",
                "content": {"value": {"lists": [{"id": "a", "symbols": ["EURUSD", "MWP:EURUSD"]}]}},
            }
            client.post("/api/advanced-charts/preferences/save", json=old).raise_for_status()
            body = {
                "kind": "setting",
                "name": "mw.symbol-flags.v1",
                "content": {
                    "value": {"version": 1, "flags": {"EURUSD": "red", "MWP:EURUSD": "blue"}}
                },
            }
            row = client.post("/api/advanced-charts/preferences/save", json=body).json()
            stale = deepcopy(body)
            for color in ("red", "blue", "green", "yellow", "purple", "cyan", "pink"):
                body["revision"] = row["revision"]
                body["content"]["value"]["flags"]["EURUSD"] = color
                response = client.post("/api/advanced-charts/preferences/save", json=body)
                response.raise_for_status()
                row = response.json()
            assert (
                client.post("/api/advanced-charts/preferences/save", json=stale).status_code == 409
            )
            body["revision"] = row["revision"]
            del body["content"]["value"]["flags"]["EURUSD"]
            client.post("/api/advanced-charts/preferences/save", json=body).raise_for_status()
            restored = client.get("/api/advanced-charts/preferences").json()
            assert (
                next(r for r in restored if r["name"] == old["name"])["content"] == old["content"]
            )
            assert next(r for r in restored if r["name"] == body["name"])["content"]["value"][
                "flags"
            ] == {"MWP:EURUSD": "blue"}
            with database() as db:
                assert len(db.scalars(select(AdvancedPreference)).all()) == 2
    finally:
        api_module.app.dependency_overrides.clear()


def test_exact_signal_lookup_and_pending_count_do_not_ack(database):
    note_id = pending(database)
    with database() as db:
        signal_id = db.get(Notification, note_id).signal_id
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            assert client.get("/api/signals/pending-count").json() == {"count": 1}
            rows = client.get("/api/signals", params={"signal": signal_id}).json()
            assert len(rows) == 1 and rows[0]["id"] == signal_id and rows[0]["ack_at"] is None
            assert client.get("/api/signals", params={"signal": "missing"}).json() == []
            assert client.get("/api/signals/pending-count").json() == {"count": 1}
            client.post(f"/api/notifications/{note_id}/ack", json={}).raise_for_status()
            assert client.get("/api/signals/pending-count").json() == {"count": 0}
    finally:
        api_module.app.dependency_overrides.clear()
