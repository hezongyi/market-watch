from decimal import Decimal as D

import pytest
from alerts import api as api_module
from alerts import storage
from alerts.domain import State
from alerts.service import acknowledge, add_replay_watch, create_watch, evaluate_watch, replay_step
from alerts.storage import (
    Bar,
    Notification,
    Outbox,
    Replay,
    SignalRow,
    Watch,
    candle_dict,
    state_dict,
)
from sqlalchemy import func, select


def seed(db):
    # Event timestamps are intentionally historical; tests control the armed time.
    prices = [(10, 11, 8, 9), (9, 10, 7, 8), (8, 9, 7, 8.5), (8.5, 10, 8, 9.5)]
    for i, p in enumerate(prices):
        db.add(
            Bar(
                instrument_id="EURUSD",
                timeframe="H4",
                start=i * 14_400_000,
                end=(i + 1) * 14_400_000,
                open=D(str(p[0])),
                high=D(str(p[1])),
                low=D(str(p[2])),
                close=D(str(p[3])),
                complete=True,
            )
        )
    db.flush()


def test_transaction_signal_outbox_and_repeat_evaluation(database):
    with database.begin() as db:
        seed(db)
        watch = create_watch(
            db, "EURUSD", "test", {"kind": "pullback", "direction": "buy"}, armed_at=28_800_000
        )
        ident = watch.id
    with database.begin() as db:
        signal = evaluate_watch(db, ident)
        assert signal.price == D("9.5")
        assert db.get(Watch, ident).status == "triggered"
    with database.begin() as db:
        assert evaluate_watch(db, ident) is None
        assert db.scalar(select(func.count()).select_from(SignalRow)) == 1
        assert db.scalar(select(func.count()).select_from(Outbox)) == 1
        note = db.scalar(select(Notification))
        acknowledge(db, note.id)
        acknowledge(db, note.id)
        assert note.status == "acknowledged"
        assert db.scalar(select(Outbox)).status == "cancelled"


def test_rollback_does_not_leave_half_trigger(database):
    with database.begin() as db:
        seed(db)
        ident = create_watch(db, "EURUSD", "test", {"kind": "pullback"}, armed_at=28_800_000).id
    with pytest.raises(RuntimeError), database.begin() as db:
        evaluate_watch(db, ident)
        raise RuntimeError("simulated crash before transaction commit")
    with database.begin() as db:
        assert db.get(Watch, ident).status == "active"
        assert db.scalar(select(func.count()).select_from(SignalRow)) == 0
        assert evaluate_watch(db, ident)


def test_incomplete_bar_stops_monitor_until_repaired(database):
    with database.begin() as db:
        seed(db)
        row = db.scalar(select(Bar).where(Bar.start == 28_800_000))
        row.complete = False
        watch = create_watch(db, "EURUSD", "test", {"kind": "pullback"}, armed_at=28_800_000)
        assert evaluate_watch(db, watch.id) is None
        assert watch.paused_reason
        row.complete = True
        db.flush()
        assert evaluate_watch(db, watch.id)


def test_replay_same_signal_and_no_real_outbox(database):
    with database.begin() as db:
        seed(db)
        rows = db.scalars(select(Bar).order_by(Bar.start)).all()
        run = Replay(
            instrument_id="EURUSD",
            timeframe="H4",
            start=28_800_000,
            end=57_600_000,
            cursor=28_800_000,
            bars=[candle_dict(r.candle()) for r in rows],
            days=[],
            watches=[],
            signals=[],
        )
        add_replay_watch(run, "simulation", {"kind": "pullback", "direction": "buy"}, "ny17")
        assert run.watches[0]["state"]["buy_ready"]
        assert replay_step(run, "ny17", 1) == 1
        assert run.signals == []
        replay_step(run, "ny17", 1)
        assert len(run.signals) == 1 and D(run.signals[0]["price"]) == D("9.5")
        assert db.scalar(select(func.count()).select_from(Outbox)) == 0


def test_state_roundtrip(database):
    assert storage.state_from(state_dict(State())) == State()


def test_authenticated_api_csrf_and_future_hidden(database, monkeypatch):
    from argon2 import PasswordHasher
    from fastapi.testclient import TestClient

    monkeypatch.setattr(
        api_module.settings, "admin_password_hash", PasswordHasher().hash("test-password-only")
    )
    monkeypatch.setattr(api_module.settings, "cookie_secure", False)
    with database.begin() as db:
        seed(db)
    with TestClient(api_module.app) as client:
        assert client.get("/api/watches").status_code == 401
        assert client.post("/api/login", json={"password": "wrong"}).status_code == 401
        logged = client.post("/api/login", json={"password": "test-password-only"})
        assert logged.status_code == 200
        assert client.post("/api/watches", json={}).status_code == 403
        client.headers["x-csrf-token"] = logged.json()["csrf"]
        response = client.post(
            "/api/replays",
            json={
                "instrument_id": "EURUSD",
                "timeframe": "H4",
                "start": 28_800_000,
                "end": 57_600_000,
            },
        )
        assert response.status_code == 201
        run = response.json()
        assert all(b["end"] <= run["cursor"] for b in run["bars"])
        assert len(run["bars"]) == 2
        saved = client.get("/api/replays").json()
        assert saved[0]["id"] == run["id"] and "bars" not in saved[0]
        exported = client.get(f"/api/replays/{run['id']}/export")
        assert exported.status_code == 200
        assert exported.json()["bars"] == run["bars"]
        assert exported.json()["simulated"] is True
        with database.begin() as db:
            bar = db.scalar(select(Bar).where(Bar.start == 0))
            bar.close = D("123")
        assert client.get(f"/api/replays/{run['id']}").json()["bars"] == run["bars"]
        response = client.post(
            f"/api/replays/{run['id']}/watches",
            json={
                "instrument_id": "EURUSD",
                "name": "回放",
                "kind": "pullback",
                "direction": "buy",
            },
        )
        assert response.status_code == 200
        response = client.post(f"/api/replays/{run['id']}/step", json={"count": 2})
        assert len(response.json()["signals"]) == 1
        assert client.get("/api/signals").json() == []
        response = client.post(f"/api/replays/{run['id']}/seek", json={"cursor": 28_800_000})
        assert response.status_code == 201
        assert response.json()["id"] != run["id"]
        assert response.json()["signals"] == []


def test_rule_version_is_persisted_and_unknown_version_rejected(database):
    with database.begin() as db:
        watch = create_watch(db, "EURUSD", "versioned", {"kind": "pullback"})
        assert watch.rule["version"] == "1"
        with pytest.raises(ValueError, match="version"):
            create_watch(db, "EURUSD", "unsupported", {"kind": "pullback", "version": "999"})


def test_replay_keeps_setup_older_than_200_bars(database):
    from alerts.api import ReplayInput, new_replay

    # Crypto's continuous calendar isolates warmup truncation from weekly closures.
    with database.begin() as db:
        prices = [(10, 11, 8, 9), (9, 10, 7, 8)] + [(8, 10, 7, 8)] * 205 + [(8, 12, 7, 11)]
        for i, p in enumerate(prices):
            db.add(
                Bar(
                    instrument_id="BTCUSDT",
                    timeframe="M5",
                    start=i * 300000,
                    end=(i + 1) * 300000,
                    open=D(p[0]),
                    high=D(p[1]),
                    low=D(p[2]),
                    close=D(p[3]),
                    complete=True,
                )
            )
    run_data = new_replay(
        ReplayInput(instrument_id="BTCUSDT", timeframe="M5", start=207 * 300000, end=208 * 300000)
    )
    with database.begin() as db:
        run = db.get(Replay, run_data["id"])
        add_replay_watch(
            run, "old setup", {"kind": "pullback", "timeframe": "M5", "direction": "buy"}, "utc0"
        )
        assert run.watches[0]["state"]["buy_ready"]
        replay_step(run, "utc0")
        assert len(run.signals) == 1
        assert run.signals[0]["price"] == "11.0000000000"


def test_signal_keeps_trigger_prices_after_source_revision(database):
    with database.begin() as db:
        seed(db)
        watch = create_watch(db, "EURUSD", "evidence", {"kind": "pullback"}, armed_at=28800000)
        result = evaluate_watch(db, watch.id)
        evidence = result.evidence
        assert D(evidence["trigger_bar"]["close"]) == D("9.5")
        assert D(evidence["previous_bar"]["high"]) == D("9")
        row = db.scalar(select(Bar).where(Bar.start == 43200000))
        row.close = D("9.9")
        row.revision += 1
        db.flush()
        assert D(result.evidence["trigger_bar"]["close"]) == D("9.5")
        assert result.evidence["trigger_bar"]["revision"] == 1
