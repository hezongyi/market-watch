from decimal import Decimal

from alerts.chart_alert_service import AlertConfig, create
from alerts.chart_alert_worker import evaluate
from alerts.storage import ChartAlert, ChartPublication, ChartPublishedBar
from sqlalchemy import event, select

MINUTE = 60_000


def seed_published(db, count, *, absent=None):
    db.add(ChartPublication(instrument_id="BTCUSDT", timeframe="M1", start=0,
                            end=count * MINUTE, complete_count=count - (absent is not None),
                            initialized=True))
    for i in range(count):
        if i == absent:
            continue
        payload = dict(start=i * MINUTE, end=(i + 1) * MINUTE,
                       open=9, high=9, low=9, close=9, complete=True,
                       volume=None, volume_complete=False, observed_at=(i + 1) * MINUTE)
        db.add(ChartPublishedBar(instrument_id="BTCUSDT", timeframe="M1",
                                start=payload["start"], end=payload["end"],
                                complete=True, payload=payload))


def price_config():
    return AlertConfig.model_validate(dict(name="bounded published read", instrument="BTCUSDT",
        source="binance", timeframe="M1", published=True, calculation_origin=0,
        condition=dict(relation="cross_up", right=dict(kind="constant", value=100_000))))


def test_warm_published_alert_reads_only_fixed_origin_and_predecessor(database):
    with database.begin() as db:
        seed_published(db, 1000)
        ident = create(db, "bounded-origin", price_config(), at=999 * MINUTE).id
        assert evaluate(db, ident, now=1000 * MINUTE) == []
        runtime = dict(db.get(ChartAlert, ident).runtime)
    loaded = []
    def record(row, context):
        loaded.append(row.start)
    event.listen(ChartPublishedBar, "load", record)
    try:
        with database.begin() as db:
            assert evaluate(db, ident, now=1000 * MINUTE) == []
            assert db.get(ChartAlert, ident).runtime == runtime
            assert db.get(ChartAlert, ident).health == "ready"
    finally:
        event.remove(ChartPublishedBar, "load", record)
    # One predecessor lookup plus the retained three-row origin window and
    # its predecessor; the latter may be materialized twice across the queries.
    assert len(loaded) <= 5 and len(set(loaded)) <= 4, (
        "Unchanged evaluation reread pre-origin published history")


def test_warm_origin_preserves_gap_fingerprint_and_detects_committed_revision(database):
    with database.begin() as db:
        seed_published(db, 10, absent=5)
        ident = create(db, "gap-origin", price_config(), at=8 * MINUTE).id
        assert evaluate(db, ident, now=10 * MINUTE) == []
        original = dict(db.get(ChartAlert, ident).runtime)
        assert original["origin"] == 6 * MINUTE
    with database.begin() as db:
        assert evaluate(db, ident, now=10 * MINUTE) == []
        alert = db.get(ChartAlert, ident)
        assert alert.health == "ready" and alert.runtime == original
        row = db.scalar(select(ChartPublishedBar).where(
            ChartPublishedBar.instrument_id == "BTCUSDT", ChartPublishedBar.start == 7 * MINUTE))
        row.payload = {**row.payload, "close": float(Decimal("9.5")), "high": 9.5}
    with database.begin() as db:
        assert evaluate(db, ident, now=10 * MINUTE) == []
        alert = db.get(ChartAlert, ident)
        assert alert.health == "blocked" and "修订" in alert.health_reason


def test_missing_fixed_origin_remains_blocked_after_bounded_read(database):
    with database.begin() as db:
        seed_published(db, 10)
        ident = create(db, "missing-origin", price_config(), at=8 * MINUTE).id
        assert evaluate(db, ident, now=10 * MINUTE) == []
        origin = db.get(ChartAlert, ident).runtime["origin"]
    with database.begin() as db:
        row = db.scalar(select(ChartPublishedBar).where(
            ChartPublishedBar.instrument_id == "BTCUSDT", ChartPublishedBar.start == origin))
        db.delete(row)
    with database.begin() as db:
        assert evaluate(db, ident, now=10 * MINUTE) == []
        alert = db.get(ChartAlert, ident)
        assert alert.health == "blocked" and "起点缺失" in alert.health_reason
