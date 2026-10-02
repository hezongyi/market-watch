import pytest
from alerts import api as api_module
from alerts.storage import Audit, LoginSession, Preference
from argon2 import PasswordHasher
from fastapi.testclient import TestClient
from sqlalchemy import select


def test_password_change_persists_and_revokes_other_sessions(database, monkeypatch):
    old, new = "old-test-password-123", "new-test-password-456"
    monkeypatch.setattr(api_module.settings, "admin_password_hash", PasswordHasher().hash(old))
    with TestClient(api_module.app, base_url="https://testserver") as client:
        token = client.post("/api/login", json={"password": old}).json()["csrf"]
        with TestClient(api_module.app, base_url="https://testserver") as other:
            other.post("/api/login", json={"password": old})
            wrong = client.post("/api/account/password", json={"current_password": "wrong", "new_password": new}, headers={"X-CSRF-Token": token})
            assert wrong.status_code == 400
            assert client.post("/api/account/password", json={"current_password": old, "new_password": "short"}, headers={"X-CSRF-Token": token}).status_code == 422
            assert client.post("/api/account/password", json={"current_password": old, "new_password": new}).status_code == 403
            assert client.post("/api/account/password", json={"current_password": old, "new_password": new}, headers={"X-CSRF-Token": token}).status_code == 200
            assert other.get("/api/session").status_code == 401
            assert client.get("/api/session").status_code == 200
        with database() as db:
            stored = db.get(Preference, "auth.admin").value["hash"]
            assert stored != new and PasswordHasher().verify(stored, new)
            assert len(db.scalars(select(LoginSession)).all()) == 1
            assert all(old not in str(row.details) and new not in str(row.details) for row in db.scalars(select(Audit)))
        assert client.post("/api/login", json={"password": old}).status_code == 401
        assert client.post("/api/login", json={"password": new}).status_code == 200


def test_password_change_throttles_without_altering_credential(database, monkeypatch):
    old = "old-test-password-123"
    monkeypatch.setattr(api_module.settings, "admin_password_hash", PasswordHasher().hash(old))
    with TestClient(api_module.app, base_url="https://testserver") as client:
        csrf = client.post("/api/login", json={"password": old}).json()["csrf"]
        for _ in range(10):
            assert client.post("/api/account/password", json={"current_password": "wrong", "new_password": "new-test-password-456"}, headers={"X-CSRF-Token": csrf}).status_code == 400
        assert client.post("/api/account/password", json={"current_password": old, "new_password": "new-test-password-456"}, headers={"X-CSRF-Token": csrf}).status_code == 429
        assert client.post("/api/login", json={"password": old}).status_code == 200


@pytest.mark.parametrize("password", ["aB! 9x", "密码任意字符", " abcde", "abcde ", "🦉🌙⭐🌍🍃🎈", "x" * 33])
def test_password_allows_six_characters_unicode_spaces_and_over_32(database, monkeypatch, password):
    old = "old-test-password-123"
    monkeypatch.setattr(api_module.settings, "admin_password_hash", PasswordHasher().hash(old))
    with TestClient(api_module.app, base_url="https://testserver") as client:
        csrf = client.post("/api/login", json={"password": old}).json()["csrf"]
        result = client.post("/api/account/password", json={"current_password": old, "new_password": password}, headers={"X-CSRF-Token": csrf})
        assert result.status_code == 200
        assert client.post("/api/login", json={"password": password}).status_code == 200
        if password != password.strip():
            assert client.post("/api/login", json={"password": password.strip()}).status_code == 401
