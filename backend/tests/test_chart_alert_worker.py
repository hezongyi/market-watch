from decimal import Decimal as D

from alerts import provider_cache, provider_service
from alerts.chart_alert_service import AlertConfig, create
from alerts.chart_alert_worker import evaluate
from alerts.storage import Bar, ChartAlert, Notification, ProviderBar, ProviderDataset, SignalRow
from sqlalchemy import func, select


def config(**changes):
    return AlertConfig.model_validate({
        "name": "BTC 价格", "instrument": "BTCUSDT", "source": "binance",
        "timeframe": "M1", "max_triggers": 2,
        "condition": {"relation": "cross_up", "right": {"kind": "constant", "value": 10}},
        **changes,
    })


def seed(db, prices, *, incomplete=None, absent=None):
    for i, price in enumerate(prices):
        if i == absent:
            continue
        db.add(Bar(instrument_id="BTCUSDT", timeframe="M1", start=i * 60_000,
                   end=(i + 1) * 60_000, open=D(price), high=D(price), low=D(price),
                   close=D(price), complete=i != incomplete, observed_at=(i + 1) * 60_000))
    db.flush()


def test_background_monitor_uses_creation_baseline_and_advances_without_browser(database):
    with database.begin() as db:
        seed(db, [9, 11, 12, 9, 11])
        ident = create(db, "background", config(), at=60_000).id
    with database.begin() as db:
        events = evaluate(db, ident, now=300_100)
        assert len(events) == 2
        assert db.get(ChartAlert, ident).count == 2
        assert db.get(ChartAlert, ident).status == "completed"
        assert db.scalar(select(func.count()).select_from(Notification)) == 2
    with database.begin() as db:
        assert evaluate(db, ident, now=400_000) == []
        assert db.scalar(select(func.count()).select_from(SignalRow)) == 2


def test_incomplete_close_waits_and_repair_resumes_in_order(database):
    with database.begin() as db:
        seed(db, [9, 11, 9, 11], incomplete=1)
        ident = create(db, "incomplete", config(), at=60_000).id
        assert evaluate(db, ident, now=240_100) == []
        row = db.get(ChartAlert, ident)
        assert row.health == "stale" and row.state["sequence"] == 60_000
    with database.begin() as db:
        bar = db.scalar(select(Bar).where(Bar.start == 60_000, Bar.instrument_id == "BTCUSDT"))
        bar.complete = True
    with database.begin() as db:
        assert len(evaluate(db, ident, now=240_100)) == 2


def test_missing_interval_waits_for_actual_backfill_and_flags_late_events(database):
    with database.begin() as db:
        seed(db, [9, 11, 9, 11], absent=1)
        ident = create(db, "gap", config(), at=60_000).id
        assert evaluate(db, ident, now=240_100) == []
        assert db.get(ChartAlert, ident).health == "stale"
    with database.begin() as db:
        db.add(Bar(instrument_id="BTCUSDT", timeframe="M1", start=60_000, end=120_000,
                   open=D(11), high=D(11), low=D(11), close=D(11), complete=True))
    with database.begin() as db:
        assert len(evaluate(db, ident, now=400_000)) == 2
        assert all(r.evidence["late"] for r in db.scalars(select(SignalRow)))


def test_history_revision_blocks_instead_of_resending_or_silently_using_old_state(database):
    with database.begin() as db:
        seed(db, [9, 11, 9])
        ident = create(db, "revision", config(), at=60_000).id
        assert len(evaluate(db, ident, now=180_100)) == 1
    with database.begin() as db:
        bar = db.scalar(select(Bar).where(Bar.start == 60_000, Bar.instrument_id == "BTCUSDT"))
        bar.open = bar.high = bar.low = bar.close = D(9)
        bar.revision += 1
    with database.begin() as db:
        assert evaluate(db, ident, now=180_200) == []
        row = db.get(ChartAlert, ident)
        assert row.health == "blocked" and "修订" in row.health_reason
        assert row.count == 1
        assert db.scalar(select(func.count()).select_from(SignalRow)) == 1


def test_intrabar_samples_can_rearm_multiple_times_in_one_candle(database):
    with database.begin() as db:
        seed(db, [9], incomplete=0)
        ident = create(db, "intrabar", config(mode="intrabar"), at=0).id
        evaluate(db, ident, now=60_001)
    for at, price in [(60_010, 11), (60_020, 9), (60_030, 11)]:
        with database.begin() as db:
            bar = db.scalar(select(Bar))
            bar.close, bar.high, bar.low = D(price), D(11), D(9)
            bar.observed_at = at
        with database.begin() as db:
            evaluate(db, ident, now=at + 1)
    with database() as db:
        assert db.get(ChartAlert, ident).count == 2
        assert list(db.scalars(select(SignalRow.occurred_at).order_by(SignalRow.occurred_at))) == [60_010, 60_030]


def test_intrabar_aggregated_frame_uses_latest_source_observation_time(database):
    with database.begin() as db:
        for i, price in enumerate((9, 9)):
            db.add(Bar(instrument_id="BTCUSDT", timeframe="M15", start=i*900_000, end=(i+1)*900_000,
                       open=D(price), high=D(price), low=D(price), close=D(price),
                       complete=False, observed_at=1_700_000+i))
        ident = create(db, "aggregate-intrabar", config(timeframe="M30", mode="intrabar"), at=1_600_000).id
        evaluate(db, ident, now=1_700_002)
        assert db.get(ChartAlert, ident).state["sequence"] == 1_700_001
    with database.begin() as db:
        bar = db.scalar(select(Bar).where(Bar.timeframe == "M15", Bar.start == 900_000))
        bar.close = bar.high = D(11)
        bar.observed_at = 1_700_010
        assert len(evaluate(db, ident, now=1_700_011)) == 1


def test_forex_intrabar_closed_weekend_is_distinct_from_open_session_staleness(database):
    from datetime import datetime, timezone

    friday = int(datetime(2026, 10, 2, 20, 59, tzinfo=timezone.utc).timestamp()*1000)
    saturday = int(datetime(2026, 10, 3, 13, tzinfo=timezone.utc).timestamp()*1000)
    monday = int(datetime(2026, 10, 5, 13, tzinfo=timezone.utc).timestamp()*1000)
    with database.begin() as db:
        db.add(Bar(instrument_id="EURUSD", timeframe="M1", start=friday, end=friday+60_000,
                   open=D(9), high=D(9), low=D(9), close=D(9), complete=False, observed_at=friday+1))
        ident = create(db, "intrabar-closed", config(instrument="EURUSD", source="dukascopy", mode="intrabar"), at=friday).id
        evaluate(db, ident, now=friday+2)
        assert evaluate(db, ident, now=saturday) == []
        assert db.get(ChartAlert, ident).health == "ready"
        assert "闭市" in db.get(ChartAlert, ident).health_reason
        assert evaluate(db, ident, now=monday) == []
        assert db.get(ChartAlert, ident).health == "stale"


def test_intrabar_history_revision_blocks_but_provisional_changes_do_not(database):
    with database.begin() as db:
        seed(db, [9, 9, 9], incomplete=2)
        ident = create(db, "intrabar-revision", config(mode="intrabar"), at=120_000).id
        assert evaluate(db, ident, now=180_001) == []
        assert db.get(ChartAlert, ident).runtime["confirmed_end"] == 120_000
    with database.begin() as db:
        live = db.scalar(select(Bar).where(Bar.start == 120_000))
        live.close = live.high = D(11)
        live.observed_at = 180_010
        assert len(evaluate(db, ident, now=180_011)) == 1
        historical = db.scalar(select(Bar).where(Bar.start == 0))
        historical.open = historical.high = historical.low = historical.close = D(8)
        live.observed_at = 180_020
        assert evaluate(db, ident, now=180_021) == []
        assert db.get(ChartAlert, ident).health == "blocked"
        assert "修订" in db.get(ChartAlert, ident).health_reason


def test_provider_demands_survive_absent_browser_and_protect_dataset(database, monkeypatch):
    meta = {"id": "BTCUSDT", "source": "binance", "symbol": "BTCUSDT",
            "basis": "last", "calendar": "utc0", "precision": 2}
    key = provider_cache.ensure(meta, "M1")
    with database.begin() as db:
        ident = create(db, "durable-provider", config(series_kind="provider"),
                       dataset_id=key, at=60_000).id
    calls = []
    monkeypatch.setattr(provider_service, "now_ms", lambda: 180_000)

    def read(metadata, frame, before, count, **options):
        calls.append((metadata["id"], frame, options.get("latest")))
        with database.begin() as db:
            for i, price in enumerate([9, 11, 9]):
                db.add(ProviderBar(dataset_id=key, start=i * 60_000, chart_time=i * 60_000,
                                   complete=True, observed_at=180_000,
                                   payload={"start": i * 60_000, "end": (i + 1) * 60_000,
                                            "open": str(price), "high": str(price),
                                            "low": str(price), "close": str(price), "complete": True}))
            dataset = db.get(ProviderDataset, key)
            dataset.latest_at = 180_000
            dataset.accessed_at = 0
        return {}

    monkeypatch.setattr(provider_cache, "read", read)
    provider_service.realtime_step("binance")
    assert calls == [("BTCUSDT", "M1", True)]
    with database.begin() as db:
        assert len(evaluate(db, ident, now=180_000)) == 1
    monkeypatch.setattr(provider_service, "now_ms", lambda: 200 * 86_400_000)
    provider_service.cleanup()
    with database() as db:
        assert db.get(ProviderDataset, key) is not None
        assert db.scalar(select(func.count()).select_from(ProviderBar)) == 3
