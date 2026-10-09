"""Accepted historical windows retain all loaded bars without following the tail."""

import pytest
from alerts import api, market, provider_cache, provider_chart
from alerts import market_stream as stream
from alerts.chart_api import DataQuery
from alerts.managed_dataset import join, publish_frame
from alerts.market_stream_worker import Calculator
from alerts.storage import Instrument, LoginSession
from fastapi.testclient import TestClient
from test_composite_chart import populated
from test_fixed_series_revisions import correction
from test_managed_dataset import MINUTE, START
from test_managed_dataset import payload as managed_payload
from test_market_stream import session
from test_provider_cache import META, seed


@pytest.fixture
def history_client(database):
    token = "historical-window-contract"
    owner = session(database, api.digest(token))
    with database.begin() as db:
        db.get(LoginSession, owner).csrf = "history-csrf"
    with TestClient(api.app) as client:
        client.cookies.set("session", token)
        client.headers["x-csrf-token"] = "history-csrf"
        yield client, owner


def history(client, query, *, before=None, limit=3, track_history=False):
    response = client.post("/api/charts/data", json={
        **query.model_dump(by_alias=True), "before": before,
        "limit": limit, "track_history": track_history})
    assert response.status_code == 200, response.text
    page = response.json()
    assert page["bars"]
    return page


def subscribe(client, query, page, *, historical=True):
    first, last = page["bars"][0], page["bars"][-1]
    # These fields are the accepted HTTP observation passed by the native feed.
    state = {"cursor": last.get("chart_time", last["start"]),
        "loaded_after": first["start"], "loaded_before": last["start"],
        "history_revision": (page.get("history_check") or {}).get("next_revision"),
        "initial_input_revision": page.get("input_revision"),
        "observed_at": page["as_of"], "binding": page.get("revision_id"),
        "historical": historical, "history_accepted": True}
    tail_revision = (page.get("history_check") or {}).get("next_tail_revision")
    if tail_revision is not None:
        state["history_tail_revision"] = tail_revision
    response = client.post("/api/charts/stream/subscribe", json={
        "client": "page", "listener": "chart", "generation": 1,
        "kind": "bars", "query": query.model_dump(by_alias=True), **state})
    assert response.status_code == 200, response.text
    return Calculator(), {}


def publish(calculator, owner, cursors):
    work = stream.claim()
    assert work
    payload, _ = calculator.build(work)
    stream.commit(work, payload, delay_ms=0)
    return stream.events(owner, "page", cursors)


@pytest.mark.parametrize("frame", ["M1", "M5"])
def test_composite_historical_last_bucket_correction_resets_from_http_observation(
        database, monkeypatch, history_client, frame):
    composite, revision, seam = populated(database, monkeypatch)
    client, owner = history_client
    query = DataQuery(instrument=composite, series_kind="composite", timeframe=frame,
                      provisional=False)
    page = history(client, query, before=seam + 300000)
    calculator, cursors = subscribe(client, query, page)
    initial = publish(calculator, owner, cursors)[0]
    assert initial["type"] == "status", initial.get("reason")
    # The final minute in the last M5 bucket matters as much as its first minute.
    at = page["bars"][-1]["start"] if frame == "M1" else page["bars"][-1]["end"] - 60000
    with database.begin() as db:
        correction(db, revision, at, 201000000, "1.119")
    event = publish(calculator, owner, cursors)[0]
    assert event["type"] == "reset" and event["reason"] == "history_changed", (
        "A correction to any minute of the last accepted historical bucket must reload")


@pytest.mark.parametrize("frame", ["M1", "D1"])
def test_provider_historical_last_bar_correction_resets_from_http_observation(
        database, monkeypatch, history_client, frame):
    meta = {**META, "name": "Test EURUSD"}
    monkeypatch.setattr(provider_chart, "metadata", lambda *args, **kwargs: meta)
    clock = [stream.now_ms()]
    monkeypatch.setattr(provider_cache, "now_ms", lambda: clock[0])
    span = 60000 if frame == "M1" else 86400000
    # D1 uses a NY17 session-open key and a distinct UTC trading-date label.
    origin, label_offset = (60000, 0) if frame == "M1" else (1767650400000, 7200000)
    bars = [{"start": origin + index * span, "end": origin + (index + 1) * span,
        "chart_time": origin + index * span + label_offset,
        "open": "1", "high": "3", "low": "0", "close": "2", "complete": True}
        for index in range(8)]
    seed(meta, frame, bars[-1]["chart_time"] + span,
         {"bars": bars, "history_boundary": False})
    client, owner = history_client
    query = DataQuery(instrument=meta["id"], series_kind="provider", timeframe=frame)
    page = history(client, query, before=bars[4]["chart_time"] + 1)
    assert page["bars"][-1]["start"] == bars[4]["start"]
    calculator, cursors = subscribe(client, query, page)
    initial = publish(calculator, owner, cursors)[0]
    assert initial["type"] == "status", initial.get("reason")
    clock[0] += 1000
    seed(meta, frame, bars[4]["chart_time"] + span,
         {"bars": [{**bars[4], "close": "2.5"}], "history_boundary": False})
    event = publish(calculator, owner, cursors)[0]
    assert event["type"] == "reset" and event["reason"] == "history_changed", (
        "Historical correction coverage includes the final accepted bar and its native date label")


def test_composite_historical_window_ignores_later_buckets(database, monkeypatch, history_client):
    composite, revision, seam = populated(database, monkeypatch)
    client, owner = history_client
    query = DataQuery(instrument=composite, series_kind="composite", timeframe="M5",
                      provisional=False)
    page = history(client, query, before=seam + 300000)
    calculator, cursors = subscribe(client, query, page)
    initial = publish(calculator, owner, cursors)[0]
    assert initial["type"] == "status", initial.get("reason")
    for at in (page["bars"][-1]["end"], seam + 600000, seam + 660000):
        with database.begin() as db:
            correction(db, revision, at, 201000000 + at, "1.119")
        event = publish(calculator, owner, cursors)[0]
        assert event["type"] == "status" and "bars" not in event, (
            "Input at or after the accepted right bucket boundary neither appends nor resets")


def test_composite_realtime_last_bar_update_and_append_still_deliver(database, monkeypatch, history_client):
    composite, revision, seam = populated(database, monkeypatch)
    client, owner = history_client
    query = DataQuery(instrument=composite, series_kind="composite", timeframe="M1",
                      provisional=False)
    page = history(client, query)
    calculator, cursors = subscribe(client, query, page, historical=False)
    assert publish(calculator, owner, cursors)[0]["type"] == "bars"
    for at in (page["bars"][-1]["start"], seam + 600000):
        with database.begin() as db:
            correction(db, revision, at, 201000000 + at, "1.119")
        event = publish(calculator, owner, cursors)[0]
        assert event["type"] == "bars" and event["bars"][-1]["start"] == at
        assert float(event["bars"][-1]["close"]) == pytest.approx(1.119)


def write_managed(database, at, minutes, price, now, published):
    with database.begin() as db:
        inst = db.get(Instrument, "BTCUSDT")
        plan = join(db, inst, START, now) if published else None
        market.ingest(db, inst, managed_payload(at, minutes, price), received_at=now)
        if published:
            publish_frame(db, inst, plan, "M1", now)


@pytest.mark.parametrize("published", [False, True])
def test_managed_historical_last_bar_correction_resets_from_http_observation(
        database, history_client, published):
    end = START + 10 * MINUTE
    write_managed(database, START, 10, 10, end + 5000, published)
    client, owner = history_client
    query = DataQuery(instrument="BTCUSDT", timeframe="M1", published=published,
                      dataset_start=START if published else None, revision_after=START + 2 * MINUTE)
    page = history(client, query, before=START + 5 * MINUTE)
    assert page["history_check"]["next_tail_revision"]
    calculator, cursors = subscribe(client, query, page)
    initial = publish(calculator, owner, cursors)[0]
    assert initial["type"] == "status", initial.get("reason")
    write_managed(database, page["bars"][-1]["start"], 1, 20, end + 6000, published)
    event = publish(calculator, owner, cursors)[0]
    assert event["type"] == "reset" and event["reason"] == "history_changed", (
        "Published and staging history both retain corrections to the last loaded bar")


@pytest.mark.parametrize("published", [False, True])
def test_managed_historical_window_ignores_tail_append(database, history_client, published):
    end = START + 10 * MINUTE
    write_managed(database, START, 10, 10, end + 5000, published)
    client, owner = history_client
    query = DataQuery(instrument="BTCUSDT", timeframe="M1", published=published,
                      dataset_start=START if published else None, revision_after=START + 2 * MINUTE)
    page = history(client, query, before=START + 5 * MINUTE)
    calculator, cursors = subscribe(client, query, page)
    initial = publish(calculator, owner, cursors)[0]
    assert initial["type"] == "status", initial.get("reason")
    write_managed(database, end, 1, 20, end + MINUTE + 5000, published)
    event = publish(calculator, owner, cursors)[0]
    assert event["type"] == "status" and "bars" not in event, (
        "Appending after an accepted historical window cannot reset or fill its unloaded gap")


@pytest.mark.parametrize("changed_index, expected_type", [(19, "reset"), (4, "status")])
def test_provider_historical_indicator_keeps_recursive_prefix_dependency(
        database, monkeypatch, history_client, changed_index, expected_type):
    meta = {**META, "name": "Test EURUSD"}
    monkeypatch.setattr(provider_chart, "metadata", lambda *args, **kwargs: meta)
    clock = [stream.now_ms()]
    monkeypatch.setattr(provider_cache, "now_ms", lambda: clock[0])
    bars = [{"start": index * MINUTE, "end": (index + 1) * MINUTE,
        "chart_time": index * MINUTE, "open": "1", "high": "3", "low": "0",
        "close": "2", "complete": True} for index in range(1, 31)]
    seed(meta, "M1", 31 * MINUTE, {"bars": bars, "history_boundary": False})
    client, owner = history_client
    origin = bars[9]["start"]
    query = DataQuery(instrument=meta["id"], series_kind="provider", timeframe="M1",
        calculation_origin=origin,
        indicators=[{"name": "EMA", "params": {"period": 2}, "calculation_origin": origin}])
    page = history(client, query, before=25 * MINUTE + 1, limit=2)
    assert page["history_dependency_first"] == origin < page["bars"][0]["start"]
    calculator, cursors = subscribe(client, query, page)
    assert publish(calculator, owner, cursors)[0]["type"] == "status"
    clock[0] += 1000
    changed = bars[changed_index]
    seed(meta, "M1", changed["end"],
         {"bars": [{**changed, "close": "2.5"}], "history_boundary": False})
    event = publish(calculator, owner, cursors)[0]
    assert event["type"] == expected_type, (
        "Recursive study repairs include their fixed prefix and exclude input before its explicit origin")
    if expected_type == "reset":
        assert event["reason"] == "history_changed"
    else:
        assert "bars" not in event


@pytest.mark.parametrize("published", [False, True])
def test_managed_historical_indicator_keeps_recursive_prefix_dependency(
        database, history_client, published):
    end = START + 30 * MINUTE
    write_managed(database, START, 30, 10, end + 5000, published)
    client, owner = history_client
    query = DataQuery(instrument="BTCUSDT", timeframe="M1", published=published,
        dataset_start=START if published else None, revision_after=START + 23 * MINUTE,
        indicators=[{"name": "EMA", "params": {"period": 2}}])
    page = history(client, query, before=START + 25 * MINUTE, limit=2)
    assert page["bars"][0]["start"] == START + 23 * MINUTE
    assert page["origin"] == START
    calculator, cursors = subscribe(client, query, page)
    initial = publish(calculator, owner, cursors)[0]
    assert initial["type"] == "status", initial.get("reason")
    write_managed(database, START + 20 * MINUTE, 1, 20, end + 6000, published)
    event = publish(calculator, owner, cursors)[0]
    assert event["type"] == "reset" and event["reason"] == "history_changed", (
        "Recursive managed study repairs include input preceding the loaded OHLC window")


@pytest.mark.parametrize("published", [False, True])
def test_managed_last_bar_correction_between_native_history_and_first_delivery_resets(
        database, history_client, published):
    end = START + 10 * MINUTE
    write_managed(database, START, 10, 10, end + 5000, published)
    client, owner = history_client
    query = DataQuery(instrument="BTCUSDT", timeframe="M1", published=published,
                      dataset_start=START if published else None)
    page = history(client, query, before=START + 5 * MINUTE)
    assert page["history_check"]["next_tail_revision"]
    assert "next_revision" not in page["history_check"], (
        "Native first reads use no prefix tracking; their tail credential is independent")
    # The chart has accepted this HTTP snapshot, but no stream result has reached it yet.
    write_managed(database, page["bars"][-1]["start"], 1, 20, end + 6000, published)
    calculator, cursors = subscribe(client, query, page)
    event = publish(calculator, owner, cursors)[0]
    assert event["type"] == "reset" and event["reason"] == "history_changed", (
        "A last-bar correction during the native history/subscription handshake must reload")
