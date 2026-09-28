from alerts import api as api_module
from alerts.storage import ImportJob
from argon2 import PasswordHasher
from fastapi.testclient import TestClient


def test_retry_requires_auth_and_failed_state_and_preserves_cursor(database, monkeypatch):
    monkeypatch.setattr(
        api_module.settings, "admin_password_hash", PasswordHasher().hash("test-only")
    )
    monkeypatch.setattr(api_module.settings, "cookie_secure", False)
    with database.begin() as db:
        job = ImportJob(
            instrument_id="BTCUSDT",
            start=0,
            end=120000,
            cursor=60000,
            status="failed",
            attempts=5,
            error="network unavailable",
        )
        db.add(job)
        db.flush()
        ident = job.id
    with TestClient(api_module.app) as client:
        path = f"/api/imports/{ident}/retry"
        assert client.post(path).status_code == 401
        login = client.post("/api/login", json={"password": "test-only"}).json()
        assert client.post(path).status_code == 403
        client.headers["x-csrf-token"] = login["csrf"]
        result = client.post(path)
        assert result.status_code == 200
        assert result.json()["cursor"] == 60000
        assert client.post(path).status_code == 409
    with database.begin() as db:
        job = db.get(ImportJob, ident)
        assert job.status == "pending" and job.attempts == 0 and job.error is None
