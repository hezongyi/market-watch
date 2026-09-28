from datetime import UTC, datetime
from decimal import Decimal as D

from alerts.domain import Calendar, previous_session
from alerts.market import ingest
from alerts.service import create_watch, evaluate_quote
from alerts.storage import Bar, Instrument, SignalRow
from sqlalchemy import select


def test_quotes_start_after_arm_dedupe_and_cross(database):
    with database.begin() as db:
        inst = db.get(Instrument, "EURUSD")
        evaluate_quote(db, inst, 1000, D("9"), D("9.1"))
        w = create_watch(
            db,
            "EURUSD",
            "instant",
            {"kind": "price", "timeframe": "tick", "level": "10", "direction": "buy"},
            armed_at=1500,
        )
        evaluate_quote(db, inst, 2000, D("11"), D("11.1"))
        evaluate_quote(db, inst, 2000, D("11"), D("11.1"))
        assert w.status == "triggered"
        s = db.scalar(select(SignalRow))
        assert s.occurred_at == 2000 and s.evidence["observation_gap_ms"] == 1000


def test_missing_quote_baseline_does_not_immediately_trigger(database):
    with database.begin() as db:
        inst = db.get(Instrument, "EURUSD")
        w = create_watch(
            db,
            "EURUSD",
            "instant",
            {"kind": "price", "timeframe": "tick", "level": "10"},
            armed_at=1500,
        )
        evaluate_quote(db, inst, 2000, D("11"), D("11.1"))
        assert w.status == "active"


def test_monday_previous_session_is_friday_and_missing_day_not_skipped(database):
    monday = datetime(2026, 9, 28, 12, tzinfo=UTC)
    left, right = previous_session(monday, Calendar.NY17)
    assert left == datetime(2026, 9, 24, 21, tzinfo=UTC)
    assert right == datetime(2026, 9, 25, 21, tzinfo=UTC)


def test_ingest_excludes_forming_minute_and_preserves_gap(database):
    start = int(datetime(2026, 9, 28, 0, tzinfo=UTC).timestamp() * 1000)
    payload = {
        "rows": [
            {"timestamp": start + i * 60_000, "open": 10, "high": 11, "low": 9, "close": 10.5}
            for i in [0, 1, 3, 4, 5]
        ]
    }
    with database.begin() as db:
        count = ingest(
            db, db.get(Instrument, "BTCUSD"), payload, received_at=start + 5 * 60_000 + 5000
        )
        assert count == 4
        m5 = db.scalar(select(Bar).where(Bar.timeframe == "M5"))
        assert not m5.complete
        payload["rows"] = [
            {"timestamp": start + 2 * 60_000, "open": 10, "high": 12, "low": 8, "close": 11}
        ]
        ingest(db, db.get(Instrument, "BTCUSD"), payload, received_at=start + 5 * 60_000 + 5000)
        assert m5.complete and m5.high == 12 and m5.low == 8


def test_empty_import_does_not_claim_success(database, monkeypatch):
    from alerts import market
    from alerts.storage import ImportJob

    with database.begin() as db:
        job = ImportJob(instrument_id="BTCUSDT", start=0, end=60000, cursor=0)
        db.add(job)
        db.flush()
        ident = job.id
    monkeypatch.setattr(market, "fetch_source", lambda *args: {"rows": []})
    assert market.import_once()
    with database.begin() as db:
        job = db.get(ImportJob, ident)
        assert job.cursor == 0 and job.status == "pending"
        assert job.attempts == 1 and "空数据" in job.error


def test_expired_import_owner_cannot_commit(database, monkeypatch):
    from alerts import market
    from alerts.storage import ImportJob

    with database.begin() as db:
        job = ImportJob(instrument_id="BTCUSDT", start=0, end=60000, cursor=0)
        db.add(job)
        db.flush()
        ident = job.id

    def fetched(*args):
        with database.begin() as db:
            job = db.get(ImportJob, ident)
            job.lease_until += 120000
        return {"rows": [{"timestamp": 0, "open": 10, "high": 11, "low": 9, "close": 10}]}

    monkeypatch.setattr(market, "fetch_source", fetched)
    assert market.import_once()
    with database.begin() as db:
        assert db.get(ImportJob, ident).cursor == 0
        assert db.get(ImportJob, ident).status == "running"
        assert db.scalar(select(Bar)) is None


def test_live_window_gap_queues_one_durable_repair(database):
    from alerts.domain import Candle
    from alerts.market import queue_recovery, upsert
    from alerts.storage import ImportJob, instant

    with database.begin() as db:
        inst = db.get(Instrument, "BTCUSDT")
        upsert(db, inst.id, "M1", Candle(instant(0), instant(60000), D(10), D(11), D(9), D(10)))
        payload = {"rows": [{"timestamp": 180000}]}
        queue_recovery(db, inst, payload)
        db.flush()
        queue_recovery(db, inst, payload)
        jobs = db.scalars(select(ImportJob)).all()
        assert len(jobs) == 1
        assert (jobs[0].start, jobs[0].end, jobs[0].cursor) == (60000, 180000, 60000)


def test_provider_mismatch_cannot_pollute_existing_history(database):
    import pytest

    with database.begin() as db:
        instrument = db.get(Instrument, "EURUSD")
        with pytest.raises(ValueError, match="来源"):
            ingest(db, instrument, {"source": "oanda", "basis": "bid", "rows": []})
        with pytest.raises(ValueError, match="口径"):
            ingest(db, instrument, {"source": "dukascopy", "basis": "last", "rows": []})
        assert db.scalar(select(Bar)) is None


def test_oanda_sparse_aggregation_requires_closed_full_query_coverage(database):
    with database.begin() as db:
        inst = db.get(Instrument, "EURUSD")
        inst.source = "oanda"
        payload = {
            "source": "oanda",
            "basis": "bid",
            "rows": [
                {"timestamp": i * 60000, "open": 10, "high": 12, "low": 9, "close": 11}
                for i in [0, 2, 4]
            ],
            "coverage": [{"start": 0, "end": 240000}],
        }
        ingest(db, inst, payload, received_at=305000)
        m5 = db.scalar(select(Bar).where(Bar.timeframe == "M5"))
        assert not m5.complete
        payload["coverage"] = [{"start": 240000, "end": 300000}]
        payload["rows"] = []
        ingest(db, inst, payload, received_at=305000)
        assert m5.complete and m5.high == 12
        assert len(db.scalars(select(Bar).where(Bar.timeframe == "M1")).all()) == 3


def test_forming_query_coverage_cannot_become_final_just_by_waiting(database):
    with database.begin() as db:
        inst = db.get(Instrument, "EURUSD")
        inst.source = "oanda"
        payload = {
            "source": "oanda",
            "basis": "bid",
            "rows": [{"timestamp": 0, "open": 10, "high": 12, "low": 9, "close": 11}],
            "coverage": [{"start": 0, "end": 300000}],
        }
        ingest(db, inst, payload, received_at=245000)
        m5 = db.scalar(select(Bar).where(Bar.timeframe == "M5"))
        assert not m5.complete
        # A later overlapping refresh that omits the missing final minute cannot certify it.
        payload["coverage"] = [{"start": 0, "end": 240000}]
        ingest(db, inst, payload, received_at=605000)
        assert not m5.complete
        payload["coverage"] = [{"start": 240000, "end": 300000}]
        payload["rows"] = []
        ingest(db, inst, payload, received_at=605000)
        assert m5.complete


def test_live_once_never_runs_historical_import(monkeypatch):
    from alerts import market

    calls = []
    monkeypatch.setattr("sys.argv", ["market", "--once"])
    monkeypatch.setattr(market, "bootstrap", lambda: None)
    monkeypatch.setattr(market, "once", lambda *args: calls.append("live"))
    monkeypatch.setattr(market, "import_once", lambda: calls.append("import"))
    market.main()
    assert calls == ["live"]


def test_import_worker_does_not_poll_live_prices(database, monkeypatch):
    from alerts import market

    calls = []
    monkeypatch.setattr("sys.argv", ["market", "--imports-only", "--once"])
    monkeypatch.setattr(market, "bootstrap", lambda: None)
    monkeypatch.setattr(market, "once", lambda *args: calls.append("live"))
    monkeypatch.setattr(market, "import_once", lambda: calls.append("import"))
    market.main()
    assert calls == ["import"]


def test_future_quote_cannot_seed_monitor_at_earlier_arm_time(database):
    from alerts.storage import Quote

    with database.begin() as db:
        db.add(Quote(instrument_id="EURUSD", at=3000, bid=D("9"), ask=D("9.1")))
        db.flush()
        watch = create_watch(
            db,
            "EURUSD",
            "future baseline",
            {"kind": "price", "timeframe": "tick", "level": "10", "direction": "buy"},
            armed_at=2000,
        )
        assert watch.state == {}


def test_historical_ingest_cannot_clear_live_error_and_recovery_is_audited(database, monkeypatch):
    from alerts import api as api_module
    from alerts import market
    from alerts.storage import Audit

    with database.begin() as db:
        inst = db.get(Instrument, "BTCUSDT")
        inst.error = "test live connection failure"
        inst.quality = "error"
        inst.last_received = 1234
        market.ingest(
            db,
            inst,
            {"rows": [{"timestamp": 0, "open": 10, "high": 11, "low": 9, "close": 10}]},
            received_at=305000,
        )
        assert inst.error == "test live connection failure" and inst.last_received == 1234
    monkeypatch.setattr(market, "fetch_source", lambda *a, **k: {"rows": []})
    market.once("BTCUSDT")
    market.once("BTCUSDT")
    with database.begin() as db:
        assert db.get(Instrument, "BTCUSDT").error is None
        records = db.scalars(select(Audit).where(Audit.kind == "market_recovered")).all()
        assert len(records) == 1 and records[0].details["instrument"] == "BTCUSDT"
    incident = next(
        x for x in api_module.health()["market_incidents"] if x["instrument"] == "BTCUSDT"
    )
    assert not incident["current_error"] and incident["last_recovered_at"] is not None
