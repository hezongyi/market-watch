"""Mobile history pagination remains compatible with legacy chart consumers."""
import base64
import json

from alerts import api as api_module
from alerts.chart_alert_service import create
from alerts.storage import Notification, SignalRow
from fastapi.testclient import TestClient
from test_chart_alert_api import login
from test_chart_alert_service import config


def test_trigger_history_stable_cursor_detail_and_legacy_array(database, monkeypatch):
    with database.begin() as db:
        rule = create(db, "history-cursor", config(), at=0)
        ident = rule.id
        for index in range(5):
            signal = SignalRow(id=f"00000000-0000-4000-8000-{index:012d}", chart_alert_id=ident,
                instrument_id="EURUSD", occurred_at=100, created_at=200, direction="up",
                price=1.12, threshold=1.11, reason="cross_up",
                evidence={"config": config().model_dump(mode="json"), "rule_version": 1,
                          "ordinal": 1, "left": "1.12", "late": False})
            db.add(signal)
            db.flush()
            db.add(Notification(signal_id=signal.id))
    with TestClient(api_module.app) as client:
        assert client.get("/api/chart-alerts/events/page").status_code == 401
        login(client, monkeypatch)
        first = client.get("/api/chart-alerts/events/page?limit=2").json()
        assert first["has_more"] and len(first["items"]) == 2
        # A newly arrived event must not shift the historical cursor.
        with database.begin() as db:
            signal = SignalRow(chart_alert_id=ident, instrument_id="EURUSD", occurred_at=101,
                created_at=201, direction="up", price=1.12, threshold=1.11, reason="cross_up",
                evidence={"config": config().model_dump(mode="json"), "rule_version": 1,
                          "ordinal": 1, "left": "1.12", "late": False})
            db.add(signal)
            db.flush()
            db.add(Notification(signal_id=signal.id))
        second = client.get("/api/chart-alerts/events/page", params={"limit": 2, "before": first["next_cursor"]}).json()
        third = client.get("/api/chart-alerts/events/page", params={"limit": 2, "before": second["next_cursor"]}).json()
        ids = [item["id"] for page in [first, second, third] for item in page["items"]]
        assert len(set(ids)) == 5 and ids == sorted(ids, reverse=True)
        assert not third["has_more"] and third["next_cursor"] is None
        detail = client.get(f"/api/chart-alerts/events/{ids[0]}").json()
        assert detail["alert_id"] == ident and detail["ack_at"] is None
        assert client.post(f"/api/notifications/{detail['notification_id']}/ack", json={}).status_code == 200
        assert client.get(f"/api/chart-alerts/events/{ids[0]}").json()["ack_at"] is not None
        assert len(client.get("/api/chart-alerts/events").json()) == 6
        assert client.get("/api/chart-alerts/events/page", params={"alert_id": "missing"}).json()["items"] == []
        assert client.get("/api/chart-alerts/events/missing").status_code == 404
        for cursor in ["bad", base64.urlsafe_b64encode(json.dumps([True, 2, "x"]).encode()).decode(), "a" * 300]:
            assert client.get("/api/chart-alerts/events/page", params={"before": cursor}).status_code == 422
        assert client.get("/api/chart-alerts/events/page?limit=101").status_code == 422


def test_latest_trigger_and_delivery_survive_end_and_detail_reads(database, monkeypatch):
    from alerts.chart_alert_application import read
    from alerts.storage import ChartAlert, Outbox

    with database.begin() as db:
        row = create(db, "ended-delivery", config(), at=0)
        row.status, row.count = "completed", 2
        ident = row.id
        for stamp in (100, 200):
            signal = SignalRow(chart_alert_id=ident, instrument_id="EURUSD", occurred_at=stamp,
                created_at=stamp + 1, direction="up", price=1.12, threshold=1.11,
                reason="cross_up", evidence={"config": config().model_dump(mode="json")})
            db.add(signal)
            db.flush()
            note = Notification(signal_id=signal.id, status="delivery_error")
            db.add(note)
            db.flush()
            db.add(Outbox(notification_id=note.id, status="blocked", attempts=1))
        notification_id = note.id
    with TestClient(api_module.app) as client:
        login(client, monkeypatch)
        listed = client.get("/api/chart-alerts").json()[0]
        detailed = client.get(f"/api/chart-alerts/{ident}").json()
        for value in (listed, detailed):
            assert value["status"] == "completed"
            assert value["last_triggered_at"] == 200
            assert value["last_notification"]["notification_id"] == notification_id
            assert value["last_notification"]["outbox_status"] == "blocked"
        # Acknowledging the actual trigger remains visible even on an ended rule.
        assert client.post(f"/api/notifications/{notification_id}/ack", json={}).status_code == 200
        with database() as db:
            assert read(db, ident)["last_notification"]["ack_at"]
            assert db.get(ChartAlert, ident).count == 2


def test_event_delivery_evidence_belongs_to_its_own_notification(database, monkeypatch):
    from alerts.storage import Device, DeviceReceipt, Outbox

    with database.begin() as db:
        rule = create(db, "receipt-identity", config(), at=0)
        device = Device(name="isolated-test", token_hash="isolated-test-device")
        db.add(device)
        db.flush()
        ids = []
        for stamp in (100, 200):
            signal = SignalRow(chart_alert_id=rule.id, instrument_id="EURUSD", occurred_at=stamp,
                created_at=stamp + 1, direction="up", price=1.12, threshold=1.11,
                reason="cross_up", evidence={"config": config().model_dump(mode="json")})
            db.add(signal)
            db.flush()
            note = Notification(signal_id=signal.id, status="server_accepted")
            db.add(note)
            db.flush()
            db.add(Outbox(notification_id=note.id, status="accepted", attempts=2))
            ids.append(signal.id)
        db.add(DeviceReceipt(device_id=device.id, notification_id=note.id, received_at=300))
    with TestClient(api_module.app) as client:
        login(client, monkeypatch)
        own = client.get(f"/api/chart-alerts/events/{ids[1]}").json()
        other = client.get(f"/api/chart-alerts/events/{ids[0]}").json()
        assert own["device_received_at"] == 300 and own["delivery_attempts"] == 2
        assert other["device_received_at"] is None
        assert own["next_delivery_at"] is None


def test_rules_page_distinguishes_archives_and_keeps_legacy_list(database, monkeypatch):
    from alerts.storage import ChartAlert

    with database.begin() as db:
        for index in range(5):
            row = create(db, f"rule-page-{index}", config(name=f"rule {index}"), at=100)
            # The cursor's second key is only the global order when dates tie.
            # create(at=...) sets effective_at, not the model's creation clock.
            row.created_at = 100
            if index == 0:
                row.status = "archived"
    with TestClient(api_module.app) as client:
        login(client, monkeypatch)
        first = client.get("/api/chart-alerts/page?limit=2").json()
        second = client.get("/api/chart-alerts/page", params={"limit": 2, "before": first["next_cursor"]}).json()
        assert first["has_more"] and not second["has_more"]
        ids = [item["id"] for page in [first, second] for item in page["items"]]
        assert len(set(ids)) == 4 and ids == sorted(ids, reverse=True)
        archived = client.get("/api/chart-alerts/page?status=archived").json()
        assert len(archived["items"]) == 1 and archived["items"][0]["status"] == "archived"
        assert len(client.get("/api/chart-alerts").json()) == 4
        assert client.get("/api/chart-alerts/page?before=bad").status_code == 422
        assert client.get("/api/chart-alerts/page?limit=101").status_code == 422
        with database.begin() as db:
            assert db.get(ChartAlert, ids[0]).status == "active"


def test_expired_edit_is_separate_from_resume(database, monkeypatch):
    from alerts.storage import ChartAlert
    from test_composite_alerts import ready_config

    make = ready_config(database, monkeypatch)
    with TestClient(api_module.app) as client:
        login(client, monkeypatch)
        rule = client.post("/api/chart-alerts", json={"request_id": "expired-mobile", "config": make().model_dump(mode="json")}).json()
        with database.begin() as db:
            row = db.get(ChartAlert, rule["id"])
            row.status = "expired"
            row.expires_at = make.at - 1
        # Editing does not promise a resumed rule or reset its existing count.
        edited = client.post(f"/api/chart-alerts/{rule['id']}/edit", json={"version": 1, "config": make(expires_at=None).model_dump(mode="json")})
        assert edited.status_code == 200
        updated = edited.json()
        assert updated["status"] == "expired" and updated["count"] == 0
        resumed = client.post(f"/api/chart-alerts/{rule['id']}/lifecycle", json={"version": updated["version"], "control_revision": updated["control_revision"], "action": "resume", "request_id": "explicit-resume"})
        assert resumed.status_code == 200 and resumed.json()["status"] == "active"
