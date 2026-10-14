"""Actual PostgreSQL commit/publication/consumer acceptance at period handoff."""
import pytest

from alerts import market_stream as stream, provider_cache as cache
from alerts.chart_api import DataQuery
from test_market_stream import session
from test_provider_cache import META, seed
from test_provider_postgres import provider_pg


def setup(provider_pg, monkeypatch, frame="M1"):
    clock = [10000000]
    monkeypatch.setattr(cache, "now_ms", lambda: clock[0])
    row = dict(start=60000, end=120000, chart_time=60000, open="1", high="3", low="0",
               close="2", volume="5", complete=False)
    older = {**row, "start": 0, "chart_time": 0, "end": 60000, "complete": True}
    key = seed(META, frame, 120000, {"bars": [older, row], "history_boundary": False})
    owner = session(provider_pg[0])
    query = DataQuery(instrument=META["id"], series_kind="provider", timeframe=frame)
    registered = stream.register(owner, "page", "chart", 1,
        {"kind": "bars", "series_kind": "provider", "dataset_id": key}, query.model_dump(),
        dict(history_accepted=True, loaded_after=0, loaded_before=row["start"],
             cursor=row["start"], observed_at=clock[0]))
    return clock, row, older, key, owner, registered, {}


def publish(key, owner, cursors):
    work = stream.claim()
    assert work
    page = cache.snapshot(key, 100000000, 2000)
    stream.commit(work, {"type": "bars", **page}, delay_ms=0)
    return stream.events(owner, "page", cursors)[0]


def accept(owner, registered, event):
    return stream.accept_provider(owner, "page", "chart", 1,
        event["result_epoch"], event["sequence"], event["provider_acceptance"])


@pytest.mark.parametrize("frame", ["M1", "M5", "H4"])
@pytest.mark.parametrize("change", [{"complete": True}, {"complete": True, "close": "2.5"},
                                  {"complete": True, "volume": "6"}])
def test_confirmed_handoff_accepted_by_native_callback_does_not_reset(
        provider_pg, monkeypatch, frame, change):
    clock, row, older, key, owner, registered, cursors = setup(provider_pg, monkeypatch, frame)
    assert publish(key, owner, cursors)["type"] == "bars"
    clock[0] += 1000
    tail = {**row, "start": 120000, "chart_time": 120000, "end": 180000}
    seed(META, frame, 180000, {"bars": [{**row, **change}, tail], "history_boundary": False})
    handoff = publish(key, owner, cursors)
    assert handoff["type"] == "bars"
    assert accept(owner, registered, handoff)["ok"]
    clock[0] += 1000
    seed(META, frame, 180000, {"bars": [{**tail, "close": "2.2"}], "history_boundary": False})
    next_event = publish(key, owner, cursors)
    assert next_event["type"] == "bars", next_event
    assert next_event["bars"][-1]["close"] == "2.2"


@pytest.mark.parametrize("repair", ["same_price", "same_volume", "older", "delete", "no_accept"])
def test_acceptance_cannot_hide_other_history_repairs(provider_pg, monkeypatch, repair):
    clock, row, older, key, owner, registered, cursors = setup(provider_pg, monkeypatch)
    publish(key, owner, cursors)
    clock[0] += 1000
    confirmed = {**row, "complete": True}
    tail = {**row, "start": 120000, "chart_time": 120000, "end": 180000}
    seed(META, "M1", 180000, {"bars": [confirmed, tail], "history_boundary": False})
    handoff = publish(key, owner, cursors)
    clock[0] += 1000
    if repair == "same_price":
        seed(META, "M1", 120000, {"bars": [{**confirmed, "close": "2.5"}], "history_boundary": False})
    elif repair == "same_volume":
        seed(META, "M1", 120000, {"bars": [{**confirmed, "volume": "6"}], "history_boundary": False})
    elif repair == "older":
        seed(META, "M1", 60000, {"bars": [{**older, "close": "2.5"}], "history_boundary": False})
    elif repair == "delete":
        seed(META, "M1", 60000, {"bars": [], "history_boundary": False,
             "revalidation": True, "coverage": [[0, 60000]]})
    if repair != "no_accept":
        # Ack arrives after a concurrent repair. It proves the delivered value,
        # not the later mutable row or a global observation timestamp.
        assert accept(owner, registered, handoff)["ok"]
    seed(META, "M1", 180000, {"bars": [{**tail, "close": "2.2"}], "history_boundary": False})
    event = publish(key, owner, cursors)
    assert event["type"] == "reset" and event["reason"] == "history_changed", event


@pytest.mark.parametrize("invalid", ["generation", "epoch", "fingerprint", "sequence", "other_session"])
def test_acceptance_is_fenced_to_the_published_value_and_consumer(provider_pg, monkeypatch, invalid):
    clock, row, older, key, owner, registered, cursors = setup(provider_pg, monkeypatch)
    event = publish(key, owner, cursors)
    receipts = event["provider_acceptance"]
    if invalid == "fingerprint":
        receipts = [{**receipts[0], "fingerprint": "0" * 64}]
    if invalid == "other_session":
        owner = session(provider_pg[0], "other-session")
        stream.register(owner, "page", "chart", 1, {"kind": "bars", "series_kind": "provider",
            "dataset_id": "other"}, DataQuery(instrument="OTHER", series_kind="provider", timeframe="M1").model_dump(), {})
    result = stream.accept_provider(owner, "page", "chart", 2 if invalid == "generation" else 1,
        "other-epoch" if invalid == "epoch" else event["result_epoch"],
        event["sequence"] + 1 if invalid == "sequence" else event["sequence"], receipts)
    assert not result["ok"]


def test_late_acceptance_and_reconnect_do_not_roll_back_newer_value(provider_pg, monkeypatch):
    clock, row, older, key, owner, registered, cursors = setup(provider_pg, monkeypatch)
    first = publish(key, owner, cursors)
    clock[0] += 1000
    confirmed = {**row, "complete": True, "close": "2.5"}
    seed(META, "M1", 120000, {"bars": [confirmed], "history_boundary": False})
    newer = publish(key, owner, cursors)
    assert accept(owner, registered, newer)["ok"]
    assert accept(owner, registered, first)["ok"]
    # onopen replays an old registration after the newer callback succeeded.
    stream.register(owner, "page", "chart", 1,
        {"kind": "bars", "series_kind": "provider", "dataset_id": key},
        DataQuery(instrument=META["id"], series_kind="provider", timeframe="M1").model_dump(),
        dict(history_accepted=True, loaded_after=0, loaded_before=60000, cursor=60000,
             observed_at=10000000, sequence=0, provider_acceptance=first["provider_acceptance"]))
    clock[0] += 1000
    tail = {**row, "start": 120000, "chart_time": 120000, "end": 180000}
    seed(META, "M1", 180000, {"bars": [tail], "history_boundary": False})
    appended = publish(key, owner, cursors)
    assert appended["type"] == "bars"
    assert accept(owner, registered, appended)["ok"]
    clock[0] += 1000
    seed(META, "M1", 180000, {"bars": [{**tail, "close": "2.2"}], "history_boundary": False})
    assert publish(key, owner, cursors)["type"] == "bars"


def test_fifteen_live_handoffs_keep_real_history_repairs(provider_pg, monkeypatch):
    clock, row, older, key, owner, registered, cursors = setup(provider_pg, monkeypatch)
    assert accept(owner, registered, publish(key, owner, cursors))["ok"]
    for index in range(15):
        clock[0] += 1000
        tail = {**row, "start": row["end"], "chart_time": row["end"], "end": row["end"] + 60000, "close": "2"}
        confirmed = {**row, "complete": True, "close": "2.5" if index % 2 else "2",
                     "volume": "6" if index % 3 else "5"}
        seed(META, "M1", tail["end"], {"bars": [confirmed, tail], "history_boundary": False})
        handoff = publish(key, owner, cursors)
        assert handoff["type"] == "bars", handoff
        assert accept(owner, registered, handoff)["ok"]
        clock[0] += 1000
        row = {**tail, "close": "2.2"}
        seed(META, "M1", row["end"], {"bars": [row], "history_boundary": False})
        event = publish(key, owner, cursors)
        assert event["type"] == "bars", event
        assert accept(owner, registered, event)["ok"]
    clock[0] += 1000
    seed(META, "M1", older["end"], {"bars": [{**older, "volume": "9"}], "history_boundary": False})
    event = publish(key, owner, cursors)
    assert event["type"] == "reset" and event["reason"] == "history_changed"


def test_accept_http_requires_auth_csrf_and_current_published_receipt(provider_pg, monkeypatch):
    from alerts import api
    from fastapi.testclient import TestClient

    clock, row, older, key, owner, registered, cursors = setup(provider_pg, monkeypatch)
    event = publish(key, owner, cursors)
    body = dict(client="page", listener="chart", generation=1,
                result_epoch=event["result_epoch"], sequence=event["sequence"],
                provider_acceptance=event["provider_acceptance"])
    token = "provider-accept-http"
    http_owner = session(provider_pg[0], api.digest(token))
    stream.register(http_owner, "page", "chart", 1,
        {"kind": "bars", "series_kind": "provider", "dataset_id": key},
        DataQuery(instrument=META["id"], series_kind="provider", timeframe="M1").model_dump(), {})
    with TestClient(api.app) as client:
        assert client.post("/api/charts/stream/accept", json=body).status_code == 401
        client.cookies.set("session", token)
        assert client.post("/api/charts/stream/accept", json=body).status_code == 403
        response = client.post("/api/charts/stream/accept", json=body,
                               headers={"x-csrf-token": "csrf"})
        assert response.status_code == 200 and response.json()["ok"]


def test_shared_task_acceptance_is_independent_for_each_consumer(provider_pg, monkeypatch):
    clock, row, older, key, owner, registered, cursors = setup(provider_pg, monkeypatch)
    initial = publish(key, owner, cursors)
    stream.register(owner, "slow-page", "chart", 1,
        {"kind": "bars", "series_kind": "provider", "dataset_id": key},
        DataQuery(instrument=META["id"], series_kind="provider", timeframe="M1").model_dump(),
        dict(history_accepted=True, loaded_after=0, loaded_before=row["start"],
             cursor=row["start"], observed_at=clock[0]))
    slow_cursors = {}
    stream.events(owner, "slow-page", slow_cursors)
    clock[0] += 1000
    tail = {**row, "start": 120000, "chart_time": 120000, "end": 180000}
    seed(META, "M1", 180000, {"bars": [{**row, "complete": True}, tail], "history_boundary": False})
    handoff = publish(key, owner, cursors)
    assert stream.events(owner, "slow-page", slow_cursors)[0]["type"] == "bars"
    assert accept(owner, registered, handoff)["ok"]
    clock[0] += 1000
    seed(META, "M1", 180000, {"bars": [{**tail, "close": "2.2"}], "history_boundary": False})
    assert publish(key, owner, cursors)["type"] == "bars"
    slow = stream.events(owner, "slow-page", slow_cursors)[0]
    assert slow["type"] == "reset" and slow["reason"] == "history_changed"
