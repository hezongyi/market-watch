from alerts import api as api_module
from alerts.service import create_watch, evaluate_watch
from alerts.storage import DeviceReceipt
from argon2 import PasswordHasher
from fastapi.testclient import TestClient
from sqlalchemy import select
from test_service import seed


def test_pair_sync_receipt_ack_and_revoke(database, monkeypatch):
    monkeypatch.setattr(
        api_module.settings, "admin_password_hash", PasswordHasher().hash("test-password-only")
    )
    monkeypatch.setattr(api_module.settings, "cookie_secure", False)
    with database.begin() as db:
        seed(db)
        w = create_watch(db, "EURUSD", "test", {"kind": "pullback"}, armed_at=28_800_000)
        evaluate_watch(db, w.id)
    with TestClient(api_module.app) as client:
        login = client.post("/api/login", json={"password": "test-password-only"}).json()
        client.headers["x-csrf-token"] = login["csrf"]
        device = client.post("/api/devices", json={"name": "Test phone"}).json()
        assert "token" not in client.get("/api/devices").json()[0]
        assert client.get("/api/device/sync").status_code == 401
        headers = {"authorization": "Bearer " + device["token"]}
        data = client.get("/api/device/sync", headers=headers).json()
        assert len(data["events"]) == 1
        assert data["pending_snapshot_complete"] is True
        assert client.get("/api/signals").json()[0]["device_delivery"] == "unknown"
        note = data["events"][0]["id"]
        assert (
            client.post(f"/api/device/notifications/{note}/received", headers=headers).status_code
            == 200
        )
        assert (
            client.post(f"/api/device/notifications/{note}/received", headers=headers).status_code
            == 200
        )
        assert client.get("/api/signals").json()[0]["device_delivery"] == "received"
        with database.begin() as db:
            assert len(db.scalars(select(DeviceReceipt)).all()) == 1
        assert (
            client.post(f"/api/device/notifications/{note}/ack", headers=headers).status_code == 200
        )
        assert (
            client.post(f"/api/device/notifications/{note}/ack", headers=headers).status_code == 200
        )
        data = client.get("/api/device/sync", headers=headers).json()
        assert data["events"] == [] and note in data["acked"]
        assert client.post(f"/api/devices/{device['id']}/revoke", json={}).status_code == 200
        assert client.get("/api/device/sync", headers=headers).status_code == 401
