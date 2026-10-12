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


def test_current_history_services_are_not_legacy_import_health(database):
    from alerts.storage import Audit, now_ms

    with database.begin() as db:
        db.add(Audit(kind="import_heartbeat", at=now_ms() - 600000, details={}))
    result = api_module.health()
    assert {row["id"] for row in result["history_services"]} == {
        "history_versions", "chart_history", "native_history",
    }
    assert all(row["status"] == "unknown" for row in result["history_services"])
    assert result["legacy_import"]["role"] == "compatibility"


def test_history_heartbeats_stop_independently_and_faults_are_visible(database, monkeypatch):
    from alerts import worker_health as worker

    clock = [1000000]
    monkeypatch.setattr(worker, "now_ms", lambda: clock[0])
    monkeypatch.setattr(worker.settings, "history_health_workers", list(worker.ROLES))
    for role in worker.ROLES:
        worker.heartbeat(role)
    clock[0] += worker.STALE_MS
    worker.heartbeat("chart_history")
    worker.heartbeat("legacy_import")
    worker.heartbeat("native_history", state="degraded", errors=["TimeoutError"])
    with database() as db:
        rows = {row["id"]: row for row in worker.services(db)}
    assert rows["history_versions"]["status"] == "stale"
    assert rows["chart_history"]["status"] == "running"
    assert rows["legacy_import"]["status"] == "running"
    assert rows["native_history"]["status"] == "degraded"
    assert rows["native_history"]["last_success_at"] == 1000000
    worker.Pulse("native_history").start()
    with database() as db:
        recovering = next(row for row in worker.services(db) if row["id"] == "native_history")
    assert recovering["status"] == "degraded"
    assert recovering["errors"] == ["TimeoutError"]
    worker.heartbeat("native_history")
    monkeypatch.setattr(worker.settings, "history_health_workers", ["chart_history", "native_history"])
    with database() as db:
        rows = {row["id"]: row for row in worker.services(db)}
    assert rows["native_history"]["status"] == "running"
    assert rows["legacy_import"]["status"] == "disabled"
    assert rows["history_versions"]["status"] == "disabled"


def test_worker_pulse_is_bounded_and_recovers_after_failed_report(database, monkeypatch):
    from alerts import worker_health as worker

    calls, clock = [], [1000000]
    monkeypatch.setattr(worker, "now_ms", lambda: clock[0])
    monkeypatch.setattr(worker, "heartbeat", lambda *args, **kwargs: calls.append(kwargs))
    pulse = worker.Pulse("native_history")
    for _ in range(20):
        pulse.start()
        pulse.finish()
    assert len(calls) == 2
    pulse.start()
    pulse.finish(errors=["TimeoutError"])
    assert calls[-1]["state"] == "degraded"
    def unavailable(*args, **kwargs):
        raise RuntimeError("report failed")
    monkeypatch.setattr(worker, "heartbeat", unavailable)
    pulse.start()
    pulse.finish()


def test_real_current_worker_loops_report_their_own_roles(database, monkeypatch):
    from alerts import chart_history_worker, native_history_loads, provider_chart, worker_health

    class StopAfterCycle(BaseException):
        pass

    def stop(_seconds):
        raise StopAfterCycle()

    monkeypatch.setattr(chart_history_worker, "refresh_catalog", lambda: None)
    monkeypatch.setattr(chart_history_worker, "advance_pending_plans", lambda: None)
    monkeypatch.setattr(chart_history_worker, "import_once", lambda **kw: True)
    monkeypatch.setattr(chart_history_worker.time, "sleep", stop)
    import pytest
    with pytest.raises(StopAfterCycle):
        chart_history_worker.run(lambda *args: None)
    monkeypatch.setattr(provider_chart, "warm_clients", lambda: None)
    monkeypatch.setattr(native_history_loads, "once", lambda: False)
    with pytest.raises(StopAfterCycle):
        native_history_loads.main()
    with database() as db:
        rows = {row["id"]: row for row in worker_health.services(db)}
    assert rows["chart_history"]["status"] == "running"
    assert rows["native_history"]["status"] == "running"
    assert rows["history_versions"]["status"] == "unknown"


def test_catalog_fault_does_not_stop_import_or_report_false_success(database, monkeypatch):
    from alerts import chart_history_worker as worker, worker_health
    import pytest

    class StopAfterCycle(BaseException):
        pass

    def failed():
        raise TimeoutError("source refresh failed")

    def stop(_seconds):
        raise StopAfterCycle()

    imported = []
    monkeypatch.setattr(worker, "refresh_catalog", failed)
    monkeypatch.setattr(worker, "advance_pending_plans", lambda: None)
    monkeypatch.setattr(worker, "import_once", lambda **kw: imported.append(True) or True)
    monkeypatch.setattr(worker.time, "sleep", stop)
    with pytest.raises(StopAfterCycle):
        worker.run(lambda *args: None)
    with database() as db:
        row = next(row for row in worker_health.services(db) if row["id"] == "chart_history")
    assert imported == [True]
    assert row["status"] == "degraded"
    assert row["errors"] == ["catalog:TimeoutError"]
    assert row["last_success_at"] is None
