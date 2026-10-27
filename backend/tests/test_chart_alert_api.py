from alerts import api as api_module
from alerts.storage import ChartAlert, ChartAlertVersion
from argon2 import PasswordHasher
from fastapi.testclient import TestClient
from sqlalchemy import select
from test_chart_alert_service import config


def login(client, monkeypatch):
    monkeypatch.setattr(api_module.settings, "admin_password_hash", PasswordHasher().hash("alerts-test-only"))
    monkeypatch.setattr(api_module.settings, "cookie_secure", False)
    logged = client.post("/api/login", json={"password": "alerts-test-only"})
    assert logged.status_code == 200
    client.headers["x-csrf-token"] = logged.json()["csrf"]


def test_create_edit_conflict_and_event_confirmation_via_authenticated_http(database, monkeypatch):
    from alerts.chart_alert_service import create

    with database.begin() as db:
        legacy_id = create(db, "legacy-http", config(), at=300_000).id
    with TestClient(api_module.app) as client:
        assert client.get("/api/chart-alerts").status_code == 401
        login(client, monkeypatch)
        body = {"request_id": "api-1", "config": config(notify_ntfy=True).model_dump(mode="json")}
        created = client.post("/api/chart-alerts", json=body)
        assert created.status_code == 422
        legacy = client.get(f"/api/chart-alerts/{legacy_id}")
        assert legacy.status_code == 200
        assert legacy.json()["display_label"].startswith("EURUSD · 自建行情 · bid · M5")
        client.headers.pop("x-csrf-token")
        assert client.post(f"/api/chart-alerts/{legacy_id}/lifecycle",
                           json={"version": 1, "action": "pause"}).status_code == 403
        login(client, monkeypatch)
        edited = client.post(f"/api/chart-alerts/{legacy_id}/edit", json={
            "version": 1, "config": config(name="updated").model_dump(mode="json"),
        })
        assert edited.status_code == 422
        paused = client.post(f"/api/chart-alerts/{legacy_id}/lifecycle", json={
            "version": 1, "control_revision": legacy.json()["control_revision"],
            "request_id": "legacy-pause", "action": "pause"})
        assert paused.status_code == 200 and paused.json()["status"] == "paused"
        archived = client.post(f"/api/chart-alerts/{legacy_id}/lifecycle", json={
            "version": 1, "control_revision": paused.json()["control_revision"],
            "request_id": "legacy-archive", "action": "archive"})
        assert archived.status_code == 200 and archived.json()["status"] == "archived"


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
    """Deprecated source rules reject every otherwise valid condition shape."""
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
                assert created.status_code == 422
                assert "必须绑定组合行情" in created.json()["detail"]


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
    from alerts.chart_alert_service import create

    with database.begin() as db:
        ident = create(db, "http-lifecycle", config(), at=0).id
    with TestClient(api_module.app) as client:
        login(client, monkeypatch)
        path = f"/api/chart-alerts/{ident}/lifecycle"
        row = client.get(f"/api/chart-alerts/{ident}").json()
        assert client.post(path, json={"version": 1, "action": "restart"}).status_code == 422
        assert client.post(path, json={"version": 1, "control_revision": row["control_revision"],
            "request_id": "legacy-restart", "action": "restart"}).status_code == 422
        intent = {"version": 1, "control_revision": row["control_revision"],
                  "request_id": "pause-once", "action": "pause"}
        paused = client.post(path, json=intent)
        assert paused.status_code == 200 and paused.json()["status"] == "paused"
        assert client.post(path, json=intent).json()["status"] == "paused"
        assert client.post(path, json={**intent, "request_id": "archive-once",
            "control_revision": paused.json()["control_revision"], "action": "archive"}).json()["status"] == "archived"


def test_reference_identity_and_log_cleanup_preserve_frozen_evidence_and_phone_state(database, monkeypatch):
    from alerts import notification_center as center
    from alerts.chart_alert_service import edit
    from alerts.storage import NoticeEvent, Notification, Outbox, SignalRow
    from test_notification_center import drain, observe, trigger

    signal_id = trigger(database)
    with TestClient(api_module.app) as client:
        login(client, monkeypatch)
        before = client.get("/api/chart-alerts/events").json()[0]
        assert before["notice"] is None
        assert before["display_identity"]["code"] == "EURUSD"
        assert before["display_identity"]["series_kind"] == "managed"
        frozen = before["evidence"]
        drain(database)
        projected = client.get("/api/chart-alerts/events").json()[0]
        notice = projected["notice"]
        assert notice["id"] == center.signal_event_id(signal_id)
        assert notice["first_seq"] > 0 and notice["viewed_at"] is None
        page = client.get("/api/notification-center/events").json()
        assert page["alert_unread"] == 1
        original_system_unread = page["system_unread"]
        with database.begin() as db:
            alert = db.get(ChartAlert, projected["alert_id"])
            edit(db, alert.id, alert.version, config(name="new live name", notify_ntfy=True))
        listed = client.get("/api/chart-alerts").json()[0]
        assert listed["last_triggered_at"] == projected["occurred_at"]
        assert listed["name"] == "new live name"
        with database() as db:
            task = db.scalar(select(Outbox))
            original_task = {c.name: getattr(task, c.name) for c in Outbox.__table__.columns}
            n = db.get(Notification, projected["notification_id"])
            original_notification = {c.name: getattr(n, c.name) for c in Notification.__table__.columns}
        for kind in ("viewed", "handled"):
            payload = observe(notice["id"], kind).model_dump(mode="json")
            assert client.post("/api/notification-center/observations", json=payload).status_code == 200
        cleaned = client.get("/api/chart-alerts/events").json()[0]
        assert cleaned["evidence"] == frozen
        assert cleaned["notice"]["viewed_at"] and cleaned["notice"]["handled_at"]
        assert cleaned["display_identity"] == projected["display_identity"]
        page = client.get("/api/notification-center/events").json()
        assert page["alert_unread"] == 0 and page["system_unread"] == original_system_unread
        changes = client.get("/api/notification-center/changes", params={"after": page["after"]}).json()
        assert changes["alert_unread"] == 0
        with database() as db:
            assert db.get(SignalRow, signal_id).evidence == frozen
            assert db.get(NoticeEvent, notice["id"])
            task = db.scalar(select(Outbox))
            assert {c.name: getattr(task, c.name) for c in Outbox.__table__.columns} == original_task
            n = db.get(Notification, projected["notification_id"])
            assert {c.name: getattr(n, c.name) for c in Notification.__table__.columns} == original_notification
