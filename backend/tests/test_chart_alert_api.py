from alerts import api as api_module
from alerts.chart_alert_domain import Observation
from alerts.chart_alert_service import consume
from alerts.storage import ChartAlert, ChartAlertVersion
from argon2 import PasswordHasher
from fastapi.testclient import TestClient
from sqlalchemy import select
from test_chart_alert_service import config, sample


def login(client, monkeypatch):
    monkeypatch.setattr(api_module.settings, "admin_password_hash", PasswordHasher().hash("alerts-test-only"))
    monkeypatch.setattr(api_module.settings, "cookie_secure", False)
    logged = client.post("/api/login", json={"password": "alerts-test-only"})
    assert logged.status_code == 200
    client.headers["x-csrf-token"] = logged.json()["csrf"]


def test_create_edit_conflict_and_event_confirmation_via_authenticated_http(database, monkeypatch):
    with TestClient(api_module.app) as client:
        assert client.get("/api/chart-alerts").status_code == 401
        login(client, monkeypatch)
        body = {"request_id": "api-1", "config": config(notify_ntfy=True).model_dump(mode="json")}
        created = client.post("/api/chart-alerts", json=body)
        assert created.status_code == 201
        row = created.json()
        assert row["display_label"].startswith("EURUSD · 自建行情 · bid · M5")
        assert row["health"] == "warming" and row["count"] == 0
        assert client.post("/api/chart-alerts", json=body).json()["id"] == row["id"]
        changed = {**body, "config": config(name="different").model_dump(mode="json")}
        assert client.post("/api/chart-alerts", json=changed).status_code == 409
        client.headers.pop("x-csrf-token")
        assert client.post(f"/api/chart-alerts/{row['id']}/lifecycle",
                           json={"version": 1, "action": "pause"}).status_code == 403
        login(client, monkeypatch)
        edited = client.post(f"/api/chart-alerts/{row['id']}/edit", json={
            "version": 1, "config": config(name="updated").model_dump(mode="json"),
        })
        assert edited.status_code == 200 and edited.json()["version"] == 2
        assert client.post(f"/api/chart-alerts/{row['id']}/edit", json={
            "version": 1, "config": config().model_dump(mode="json"),
        }).status_code == 409
        with database.begin() as db:
            alert = db.get(ChartAlert, row["id"])
            at = alert.effective_at
            consume(db, alert.id, Observation("baseline", 1, at, sample(0, 9).left, sample(0, 9).right), detected_at=at)
            consume(db, alert.id, Observation("live", 2, at + 1000, sample(0, 11).left, sample(0, 11).right), detected_at=at + 1001)
        events = client.get("/api/chart-alerts/events").json()
        assert len(events) == 1 and events[0]["evidence"]["rule_version"] == 2
        assert events[0]["display_label"] == row["display_label"]
        assert client.post(f"/api/notifications/{events[0]['notification_id']}/ack").status_code == 200
        assert client.get("/api/chart-alerts/events").json()[0]["ack_at"] is not None
        assert client.get("/api/signals").json()[0]["id"] == events[0]["id"]
        assert client.get("/api/chart-alerts?search=updated&status=active").json()[0]["id"] == row["id"]


def test_invalid_contract_and_message_placeholders_are_rejected(database, monkeypatch):
    with TestClient(api_module.app) as client:
        login(client, monkeypatch)
        bad = config().model_dump(mode="json")
        bad["max_triggers"] = 4
        assert client.post("/api/chart-alerts", json={"request_id": "bad", "config": bad}).status_code == 422
        bad["max_triggers"] = 2
        bad["message"] = "{symbol.__class__}"
        assert client.post("/api/chart-alerts", json={"request_id": "bad", "config": bad}).status_code == 422
        assert client.get("/api/chart-alerts/events?limit=501").status_code == 422
        assert client.get("/api/chart-alerts?status=unknown").status_code == 422


def test_range_single_edits_persist_precision_and_keep_strict_contract(database, monkeypatch):
    """Real saves complement the browser's normalized request-shape matrix."""
    with TestClient(api_module.app) as client:
        login(client, monkeypatch)
        for interval in ("enter", "exit", "break_upper", "break_lower"):
            for single in ("cross", "cross_up", "cross_down", "above", "below"):
                payload = config().model_dump(mode="json")
                bounds = {"relation": interval, "left": {"kind": "price"},
                          "lower": "1.12345", "upper": "2.123"}
                payload["condition"] = bounds
                created = client.post("/api/chart-alerts", json={
                    "request_id": f"matrix-{interval}-{single}", "config": payload})
                assert created.status_code == 201, created.text
                row = created.json()
                path = f"/api/chart-alerts/{row['id']}/edit"
                comparison = {"relation": single, "left": {"kind": "price"},
                              "right": {"kind": "constant", "value": "0"}}
                payload["condition"] = {**comparison, "lower": "1.12345", "upper": "2.123"}
                assert client.post(path, json={"version": 1, "config": payload}).status_code == 422
                payload["condition"] = comparison
                saved = client.post(path, json={"version": 1, "config": payload})
                assert saved.status_code == 200, saved.text
                assert saved.json()["config"]["condition"]["right"]["value"] == "0"
                payload["condition"] = bounds
                saved = client.post(path, json={"version": 2, "config": payload})
                assert saved.status_code == 200, saved.text
                assert saved.json()["config"]["condition"]["lower"] == "1.12345"
                assert saved.json()["config"]["condition"]["upper"] == "2.123"


def test_rule_versions_cannot_be_mutated_or_deleted(database):
    import pytest
    from alerts.chart_alert_service import create

    with database.begin() as db:
        ident = create(db, "immutable", config(), at=0).id
    with pytest.raises(ValueError, match="不可变"):
        with database.begin() as db:
            version = db.scalar(select(ChartAlertVersion).where(ChartAlertVersion.alert_id == ident))
            version.config = config(name="illegal mutation").model_dump(mode="json")
    with pytest.raises(ValueError, match="不可变"):
        with database.begin() as db:
            db.delete(db.scalar(select(ChartAlertVersion).where(ChartAlertVersion.alert_id == ident)))


def test_lifecycle_http_requires_revision_and_replays_same_request_once(database, monkeypatch):
    with TestClient(api_module.app) as client:
        login(client, monkeypatch)
        row = client.post("/api/chart-alerts", json={
            "request_id": "http-lifecycle", "config": config().model_dump(mode="json"),
        }).json()
        path = f"/api/chart-alerts/{row['id']}/lifecycle"
        assert client.post(path, json={"version": 1, "action": "restart"}).status_code == 422
        intent = {"version": 1, "control_revision": row["control_revision"],
                  "request_id": "restart-once", "action": "restart"}
        first = client.post(path, json=intent)
        assert first.status_code == 200 and first.json()["run"] == 2
        assert client.post(path, json=intent).json()["run"] == 2
        assert client.post(path, json={**intent, "request_id": "stale-restart"}).status_code == 409
        assert client.post(path, json={**intent, "action": "pause"}).status_code == 409
