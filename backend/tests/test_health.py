from alerts import api as api_module
from fastapi.testclient import TestClient


def test_public_liveness_and_readiness(database, monkeypatch):
    with TestClient(api_module.app) as client:
        live = client.get("/healthz")
        ready = client.get("/readyz")
        assert live.status_code == 200 and live.json()["status"] == "ok"
        assert ready.status_code == 200 and ready.json()["status"] == "ready"


def test_readiness_returns_503_on_database_failure(database, monkeypatch):
    def broken():
        raise RuntimeError("database unavailable")

    monkeypatch.setattr(api_module, "transaction", broken)
    with TestClient(api_module.app) as client:
        response = client.get("/readyz")
        assert response.status_code == 503 and response.json()["status"] == "not_ready"


def test_health_includes_independent_import_heartbeat(database):
    from alerts.storage import Audit, now_ms

    with database.begin() as db:
        db.add(Audit(kind="import_heartbeat", at=now_ms() - 600000, details={}))
        for _ in range(25):
            db.add(Audit(kind="market_heartbeat", details={}))
    result = api_module.health()
    assert result["worker_status"]["market_heartbeat"] == "running"
    assert result["worker_status"]["import_heartbeat"] == "stale"
    assert result["worker_status"]["notify_heartbeat"] == "unknown"
    assert "import_heartbeat" in result["workers"]
