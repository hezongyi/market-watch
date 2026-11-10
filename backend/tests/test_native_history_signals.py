"""Wakeups are commit hints; authorization and final snapshots stay in the core."""

import threading
import time

from alerts import api as api_module
from alerts import native_history_loads as loads
from alerts import native_history_signals as signals
from fastapi.testclient import TestClient


def test_notifications_only_after_successful_commit(database):
    seen = []
    with signals.watch(seen.append):
        with database.begin() as db:
            signals.notify(db, "committed")
            assert seen == []
        assert seen == ["committed"]
        try:
            with database.begin() as db:
                signals.notify(db, "rolled-back")
                raise ValueError("rollback")
        except ValueError:
            pass
    assert seen == ["committed"]


def test_wait_reads_authoritative_result_on_hint_and_preserves_owner(database, monkeypatch):
    calls = []
    finished = threading.Event()
    def result(owner, ident):
        calls.append((owner, ident))
        if finished.is_set():
            return {"load": {"id": ident, "state": "ready", "pages": 1}, "result": {"bars": [1]}}
        return {"load": {"id": ident, "state": "waiting"}}
    def complete():
        time.sleep(0.05)
        finished.set()
        signals._dispatch("task")
    monkeypatch.setattr(loads, "result", result)
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            worker = threading.Thread(target=complete)
            worker.start()
            response = client.get("/api/charts/history-loads/task/result?wait_ms=1500")
            worker.join(1)
            assert response.status_code == 200
            assert response.json()["result"]["bars"] == [1]
            assert len(calls) >= 2
            assert len(set(calls)) == 1, "hints must not change owner or task identity"
            assert client.get("/api/charts/history-loads/task/result?wait_ms=1501").status_code == 422
    finally:
        api_module.app.dependency_overrides.clear()
    assert not signals._callbacks, "disconnected/finished waits release observers"


def test_wait_fallback_rereads_without_notification(database, monkeypatch):
    calls = []
    def result(owner, ident):
        calls.append(ident)
        return {"load": {"id": ident, "state": "waiting"}}
    monkeypatch.setattr(loads, "result", result)
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            response = client.get("/api/charts/history-loads/task/result?wait_ms=20")
            assert response.status_code == 200
            assert response.json()["load"]["state"] == "waiting"
            assert len(calls) >= 2
    finally:
        api_module.app.dependency_overrides.clear()


def test_submit_wait_disconnect_reclaims_handle_not_yet_received(database, monkeypatch):
    from starlette.requests import Request
    cancelled = []
    async def disconnected(self):
        return True
    monkeypatch.setattr(Request, "is_disconnected", disconnected)
    monkeypatch.setattr(loads, "submit", lambda *a: {"load": {"id": "hidden", "state": "waiting"}})
    monkeypatch.setattr(loads, "result", lambda *a: {"load": {"id": "hidden", "state": "waiting"}})
    monkeypatch.setattr(loads, "status", lambda owner, ident, cancel=False: cancelled.append((owner, ident, cancel)))
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            response = client.post("/api/charts/history-loads?wait_ms=3000", json={
                "request_id": "request", "query": {"instrument": "EURUSD", "series_kind": "provider",
                "timeframe": "M5", "countBack": 200, "native_history": {"chart_count": 1}},
            })
            assert response.status_code == 200
            assert len(cancelled) == 1 and cancelled[0][1:] == ("hidden", True)
    finally:
        api_module.app.dependency_overrides.clear()


def test_submit_wait_disconnect_persists_cancelled_consumer(database, monkeypatch):
    from alerts import provider_chart
    from alerts.storage import NativeHistoryLoad
    from sqlalchemy import select
    from starlette.requests import Request
    from test_provider_cache import META

    async def disconnected(self):
        return True
    monkeypatch.setattr(Request, "is_disconnected", disconnected)
    monkeypatch.setattr(provider_chart, "metadata", lambda *a, **k: META)
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            response = client.post("/api/charts/history-loads?wait_ms=3000", json={
                "request_id": "actual-disconnect", "query": {"instrument": META["id"],
                "series_kind": "provider", "timeframe": "M5", "before": 40000000,
                "countBack": 200, "native_history": {"chart_count": 1}},
            })
            assert response.status_code == 200
            with database() as db:
                row = db.scalar(select(NativeHistoryLoad).where(
                    NativeHistoryLoad.request_id == "actual-disconnect"))
                assert row.state == "cancelled" and row.generation == 1
    finally:
        api_module.app.dependency_overrides.clear()
