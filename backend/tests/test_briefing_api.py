"""Authenticated request contracts, including reads that never generate reports."""

import uuid

from alerts import api
from alerts.storage import BriefingReport
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from test_briefing import seed
from test_chart_alert_api import login


def test_auth_csrf_revision_read_only_and_preview_retry(database, monkeypatch):
    with database.begin() as db:
        seed(db)
    with TestClient(api.app) as client:
        assert client.get("/api/briefings/plan").status_code == 401
        login(client, monkeypatch)
        plan = client.get("/api/briefings/plan").json()
        assert plan["group_ids"] == ["fx"]
        assert client.get("/api/briefings/reports").json()["items"] == []
        for _ in range(3):
            assert client.get("/api/briefings/plan").status_code == 200
        with database() as db:
            assert db.scalar(select(func.count()).select_from(BriefingReport)) == 0
        csrf = client.headers.pop("x-csrf-token")
        assert (
            client.post(
                "/api/briefings/plan", json={"enabled": False, "group_ids": ["fx"], "revision": 1}
            ).status_code
            == 403
        )
        client.headers["x-csrf-token"] = csrf
        assert (
            client.post(
                "/api/briefings/plan", json={"enabled": True, "group_ids": ["fx"], "revision": 0}
            ).status_code
            == 409
        )
        assert (
            client.post(
                "/api/briefings/plan",
                json={"enabled": True, "group_ids": ["missing"], "revision": 1},
            ).status_code
            == 422
        )
        request = str(uuid.uuid4())
        first = client.post("/api/briefings/preview", json={"request_id": request})
        assert first.status_code == 200 and first.json()["status"] == "pending"
        assert (
            client.post("/api/briefings/preview", json={"request_id": request}).json()["id"]
            == request
        )
        assert client.get("/api/briefings/reports/" + request).json()["mode"] == "preview"
        assert client.get("/api/briefings/reports/" + str(uuid.uuid4())).status_code == 404
        assert client.get("/api/briefings/reports?limit=100").status_code == 422
        assert client.get("/api/briefings/reports?before=invalid").status_code == 422
        assert (
            client.post(
                "/api/briefings/plan", json={"enabled": False, "group_ids": ["fx"], "revision": 1}
            ).status_code
            == 200
        )
