"""Fixture safeguards and the real managed publication-to-worker seam.

SQLite here checks the fixture/harness input contract, not Docker acceptance.
"""

import importlib.util
import json
import sys
from pathlib import Path

import pytest
from alerts import market_stream as stream
from alerts.chart_data import FRAMES
from alerts.chart_query import DataQuery
from alerts.market_stream_api import Subscription, resolve
from alerts.market_stream_worker import Calculator
from alerts.storage import ChartPublication, ChartPublishedBar, Instrument, now_ms
from test_market_stream import session

spec = importlib.util.spec_from_file_location("sse_acceptance_fixture",
    Path(__file__).resolve().parents[2] / "scripts" / "unified_sse_acceptance_fixture.py")
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


def invoke(monkeypatch, capsys, *args):
    monkeypatch.setattr(sys, "argv", ["fixture", *args])
    fixture.main()
    return json.loads(capsys.readouterr().out)


@pytest.mark.parametrize("field,value", [
    ("database_application_name", "another-task"),
    ("database_url", "postgresql+psycopg://alerts@unraid/alerts"),
    ("database_url", "postgresql+psycopg://alerts@postgres/production"),
    ("delivery_enabled", True),
])
def test_fixture_rejects_other_task_or_database_before_transaction(monkeypatch, field, value):
    monkeypatch.setattr(fixture.settings, "database_application_name", fixture.TASK)
    monkeypatch.setattr(fixture.settings, "database_url", "postgresql+psycopg://alerts@postgres/alerts")
    monkeypatch.setattr(fixture.settings, "delivery_enabled", False)
    monkeypatch.setattr(fixture.settings, field, value)

    def unexpected_transaction():
        pytest.fail("Guard must refuse before opening a database transaction")

    monkeypatch.setattr(fixture, "transaction", unexpected_transaction)
    monkeypatch.setattr(sys, "argv", ["fixture", "seed"])
    with pytest.raises(SystemExit, match="Refusing any database"):
        fixture.main()


def test_fixture_updates_drive_authoritative_managed_stream_and_short_replay(database, monkeypatch, capsys):
    monkeypatch.setattr(fixture, "guard", lambda: None)  # Only this in-memory test.
    initial = invoke(monkeypatch, capsys, "seed")
    assert initial["committed_at"] <= now_ms()
    assert invoke(monkeypatch, capsys, "seed")["bar"] == initial["bar"]
    owner = session(database)
    query = DataQuery(instrument=fixture.SYMBOL, timeframe="M1", published=True)
    identity, serialized = resolve(Subscription(client="browser", listener="native", generation=1,
        kind="bars", query=query))
    stream.register(owner, "browser", "native", 1, identity, serialized,
        {"cursor": initial["bar"]["start"], "history_accepted": True,
         "loaded_after": initial["bar"]["start"] - 600000,
         "loaded_before": initial["bar"]["start"]})
    calculator, cursors = Calculator(), {}

    def publish(deliver=True):
        work = stream.claim()
        assert work
        payload, _ = calculator.build(work)
        stream.commit(work, payload, delay_ms=0)
        return stream.events(owner, "browser", cursors) if deliver else None

    assert publish()[0]["type"] == "bars"
    for high in ("140", "110"):
        committed = invoke(monkeypatch, capsys, "update", "--close", "101.01", "--high", high)
        event = publish()[0]
        assert event["type"] == "bars"
        assert event["bars"][-1]["high"] == high
        assert event["bars"][-1]["close"] == committed["bar"]["close"]
    for close in ("102.01", "102.02", "102.03"):
        invoke(monkeypatch, capsys, "append", "--close", close)
        publish(deliver=False)
    recovered = stream.events(owner, "browser", cursors)
    assert all(event["type"] == "bars" for event in recovered)
    assert {bar["start"] for event in recovered for bar in event["bars"]} >= {
        initial["bar"]["start"] + offset * 60000 for offset in (1, 2, 3)}
    with database() as db:
        assert db.get(Instrument, fixture.SYMBOL).enabled is False


def test_invalid_fixture_update_rolls_back_publication(database, monkeypatch, capsys):
    monkeypatch.setattr(fixture, "guard", lambda: None)
    initial = invoke(monkeypatch, capsys, "seed")
    with pytest.raises(SystemExit, match="Invalid synthetic OHLC"):
        invoke(monkeypatch, capsys, "append", "--close", "1000")
    with database() as db:
        pub = db.get(ChartPublication, (fixture.SYMBOL, "M1"))
        assert pub.end == initial["bar"]["end"]
        assert pub.revision == initial["publication_revision"]
        assert db.get(ChartPublishedBar, (fixture.SYMBOL, "M1", pub.end)) is None


def test_all_synthetic_periods_use_real_calendar_bounds_and_update_independently(database, monkeypatch, capsys):
    monkeypatch.setattr(fixture, "guard", lambda: None)
    invoke(monkeypatch, capsys, "seed")
    for frame in FRAMES:
        tail = invoke(monkeypatch, capsys, "tail", "--timeframe", frame)
        with database() as db:
            pub = db.get(ChartPublication, (fixture.SYMBOL, frame))
            assert pub and pub.initialized and pub.complete_count > 0
        assert tail["bar"]["end"] <= now_ms()
        before = tail["publication_revision"]
        updated = invoke(monkeypatch, capsys, "update", "--timeframe", frame, "--close", "104.001")
        assert updated["publication_revision"] == before + 1
        assert updated["bar"]["start"] == tail["bar"]["start"]
        assert updated["bar"]["close"] == "104.001"
