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
