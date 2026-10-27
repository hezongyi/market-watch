"""Use the authenticated HTTP registration interface, including session scoping."""

from alerts import api
from alerts import market_stream as stream
from alerts.storage import LoginSession, MarketStreamSubscription
from fastapi.testclient import TestClient
from sqlalchemy import select


def test_http_authentication_csrf_and_same_client_name_do_not_cross_sessions(database):
    with database.begin() as db:
        for token in ("one", "two"):
            db.add(LoginSession(token_hash=api.digest(token), csrf="csrf-" + token,
                                expires=stream.now_ms() + 1000000))
    body = {"client": "page", "listener": "main", "generation": 2, "kind": "bars",
            "query": {"instrument": "EURUSD", "series_kind": "managed", "timeframe": "M1"}}
    with TestClient(api.app) as client:
        assert client.post("/api/charts/stream/subscribe", json=body).status_code == 401
        client.cookies.set("session", "one")
        assert client.post("/api/charts/stream/subscribe", json=body).status_code == 403
        first = client.post("/api/charts/stream/subscribe", json=body,
                            headers={"x-csrf-token": "csrf-one"})
        assert first.status_code == 200, first.text
        client.cookies.set("session", "two")
        second = client.post("/api/charts/stream/subscribe", json=body,
                             headers={"x-csrf-token": "csrf-two"})
        assert second.status_code == 200, second.text
        assert first.json()["task_id"] == second.json()["task_id"]
        response = client.post("/api/charts/stream/unsubscribe",
            json={"client": "page", "listener": "main", "generation": 2},
            headers={"x-csrf-token": "csrf-two"})
        assert response.status_code == 200
    with database.begin() as db:
        rows = list(db.scalars(select(MarketStreamSubscription)))
        assert len(rows) == 2 and sum(row.active for row in rows) == 1


def test_registration_cannot_mutate_fixed_identity_in_the_same_generation(database):
    with database.begin() as db:
        db.add(LoginSession(token_hash=api.digest("one"), csrf="csrf",
                            expires=stream.now_ms() + 1000000))
    body = {"client": "page", "listener": "main", "generation": 1, "kind": "bars",
            "query": {"instrument": "EURUSD", "series_kind": "managed", "timeframe": "M1"}}
    with TestClient(api.app) as client:
        client.cookies.set("session", "one")
        headers = {"x-csrf-token": "csrf"}
        assert client.post("/api/charts/stream/subscribe", json=body, headers=headers).status_code == 200
        body["query"]["timeframe"] = "H1"
        assert client.post("/api/charts/stream/subscribe", json=body, headers=headers).status_code == 422
        body["generation"] = 2
        assert client.post("/api/charts/stream/subscribe", json=body, headers=headers).status_code == 200


def test_retired_provider_channel_cannot_renew_or_start_collection(database, monkeypatch):
    def obsolete(*args, **kwargs):
        raise AssertionError("retired HTTP channel reached the collector")

    for name in ("subscribe", "unsubscribe", "renew", "events"):
        monkeypatch.setattr("alerts.provider_service." + name, obsolete)
    with database.begin() as db:
        db.add(LoginSession(token_hash=api.digest("retired"), csrf="csrf",
                            expires=stream.now_ms() + 1000000))
    with TestClient(api.app) as client:
        assert client.get("/api/charts/provider/events?client=old").status_code == 401
        client.cookies.set("session", "retired")
        for action in ("subscribe", "unsubscribe"):
            response = client.post("/api/charts/provider/" + action, json={},
                                   headers={"x-csrf-token": "csrf"})
            assert response.status_code == 410
        assert client.get("/api/charts/provider/events?client=old").status_code == 410
