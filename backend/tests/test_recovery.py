from datetime import UTC, datetime

from alerts import market
from alerts.storage import Audit, Bar, ImportJob, Instrument, Preference, ms
from sqlalchemy import func, select

START = ms(datetime(2026, 9, 28, tzinfo=UTC))


def payload(indices, *, source="binance", span=5):
    return {
        "source": source,
        "basis": "bid" if source == "oanda" else "last",
        "window_start": START,
        "window_end": START + span * 60000,
        "rows": [
            {"timestamp": START + i * 60000, "open": 10, "high": 11, "low": 9, "close": 10}
            for i in indices
        ],
    }


def test_internal_gaps_repair_idempotently_without_forming_minute(database):
    with database.begin() as db:
        inst = db.get(Instrument, "BTCUSDT")
        data = payload([0, 2, 4, 5], span=7)
        for _ in range(2):
            market.queue_recovery(db, inst, data, received_at=START + 365000)
        jobs = db.scalars(select(ImportJob).order_by(ImportJob.start)).all()
        assert [(j.start - START, j.end - START, j.priority) for j in jobs] == [
            (60000, 120000, 0),
            (180000, 240000, 0),
        ]


def test_stored_minutes_fill_incoming_gaps(database):
    with database.begin() as db:
        inst = db.get(Instrument, "BTCUSDT")
        market.ingest(db, inst, payload([1, 3]), received_at=START + 305000)
        market.queue_recovery(db, inst, payload([0, 2, 4]), received_at=START + 305000)
        assert db.scalar(select(func.count()).select_from(ImportJob)) == 0


def test_sparse_oanda_query_coverage_does_not_loop_repairs(database):
    with database.begin() as db:
        inst = db.get(Instrument, "EURUSD")
        inst.source = "oanda"
        data = payload([0, 2, 4], source="oanda")
        data["coverage"] = [{"start": START, "end": START + 300000}]
        market.queue_recovery(db, inst, data, received_at=START + 305000)
        assert db.scalar(select(func.count()).select_from(ImportJob)) == 0
        # Uncertified gap is recoverable even when other parts are covered.
        data["coverage"][0]["end"] = START + 180000
        market.queue_recovery(db, inst, data, received_at=START + 305000)
        job = db.scalar(select(ImportJob))
        assert (job.start, job.end) == (START + 180000, START + 240000)


def test_empty_live_window_queues_bounded_gap(database):
    with database.begin() as db:
        inst = db.get(Instrument, "BTCUSDT")
        market.queue_recovery(db, inst, payload([]), received_at=START + 305000)
        job = db.scalar(select(ImportJob))
        assert (job.start, job.end) == (START, START + 300000)


def test_sparse_gap_before_window_uses_previously_saved_coverage(database):
    with database.begin() as db:
        inst = db.get(Instrument, "EURUSD")
        inst.source = "oanda"
        data = payload([0], source="oanda")
        data["coverage"] = [{"start": START, "end": START + 300000}]
        market.ingest(db, inst, data, received_at=START + 305000)
        newer = payload([], source="oanda", span=10)
        newer["window_start"] = START + 300000
        newer["coverage"] = [{"start": START + 300000, "end": START + 600000}]
        market.queue_recovery(db, inst, newer, received_at=START + 605000)
        assert db.scalar(select(func.count()).select_from(ImportJob)) == 0


def test_initial_history_is_durable_newest_first_and_lower_priority(database, monkeypatch):
    monkeypatch.setattr(market.settings, "initial_history_days", 2)
    with database.begin() as db:
        count = market.queue_initial_history(db, end=START + 5000)
        assert count == 6  # three enabled instruments, two daily slices each
        assert market.queue_initial_history(db, end=START + 86400_000) == 0
        jobs = db.scalars(select(ImportJob)).all()
        assert all(j.priority == 50 for j in jobs)
        assert {j.instrument_id for j in jobs} == {"EURUSD", "XAUUSD", "BTCUSDT"}
        assert min(j.start for j in jobs) == START - 2 * 86400_000
        assert max(j.end for j in jobs) == START
        assert db.scalar(select(func.count()).select_from(Preference).where(
            Preference.key.startswith("initial_history:"))) == 3
        db.add(
            ImportJob(
                instrument_id="BTCUSDT", start=START, end=START + 60000, cursor=START, priority=0
            )
        )
    calls = []

    def fetch(source, symbol, left, right):
        calls.append(left)
        return payload([0], span=1)

    monkeypatch.setattr(market, "fetch_source", fetch)
    market.import_once()
    assert calls == [datetime.fromtimestamp(START / 1000, UTC).isoformat()]


def test_partial_import_does_not_advance_cursor(database, monkeypatch):
    with database.begin() as db:
        job = ImportJob(instrument_id="BTCUSDT", start=START, end=START + 300000, cursor=START)
        db.add(job)
        db.flush()
        ident = job.id
    monkeypatch.setattr(market, "fetch_source", lambda *a: payload([0, 2, 4]))
    market.import_once()
    with database.begin() as db:
        job = db.get(ImportJob, ident)
        assert job.cursor == START and job.attempts == 1 and job.status == "pending"
        assert "缺少" in job.error
    monkeypatch.setattr(market, "fetch_source", lambda *a: payload(range(5)))
    with database.begin() as db:
        db.get(ImportJob, ident).next_at = 0
    market.import_once()
    with database.begin() as db:
        job = db.get(ImportJob, ident)
        assert job.cursor == START + 300000 and job.status == "complete"


def test_empty_oanda_covered_slice_is_audited_without_fabricating_candles(database, monkeypatch):
    with database.begin() as db:
        db.get(Instrument, "EURUSD").source = "oanda"
        db.add(ImportJob(instrument_id="EURUSD", start=START, end=START + 300000, cursor=START))
    data = payload([], source="oanda")
    data["coverage"] = [{"start": START, "end": START + 300000}]
    monkeypatch.setattr(market, "fetch_source", lambda *a: data)
    market.import_once()
    with database.begin() as db:
        assert db.scalar(select(ImportJob)).status == "complete"
        assert db.scalar(select(Bar)) is None
        assert db.scalar(select(Audit).where(Audit.kind == "provider_empty_interval"))
