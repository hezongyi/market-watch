"""Ordinary supplier collection cannot own composite or explicit dataset identities."""
import pytest
from alerts import market
from alerts.storage import (
    Audit,
    ChartHistoryPlan,
    ChartViewportDemand,
    ImportJob,
    Instrument,
    MarketDemand,
)
from sqlalchemy import select


@pytest.mark.parametrize("demand", ["chart", "plan", "viewport", "expired", "forced", "enabled"])
def test_composite_never_reaches_ordinary_supplier(database, monkeypatch, demand):
    now = 1791690000000
    monkeypatch.setattr(market, "now_ms", lambda: now)
    ident = "MC:routing-test:EURUSD"
    with database.begin() as db:
        for inst in db.scalars(select(Instrument)):
            inst.enabled = False
        db.add(Instrument(id=ident, label="Composite", source="composite", symbol="EURUSD",
            basis="bid", calendar="ny17", precision=5, enabled=demand == "enabled"))
        if demand == "chart":
            db.add(MarketDemand(id="chart", instrument_id=ident, expires=now + 60000))
        elif demand == "plan":
            db.add(ChartHistoryPlan(instrument_id=ident, target_start=0, target_end=60000,
                realtime_enabled=True))
        elif demand in ("viewport", "expired"):
            db.add(ChartViewportDemand(id="viewport", instrument_id=ident, timeframe="M1",
                start=0, end=60000, warm_start=0, focused=True,
                expires=now + (60000 if demand == "viewport" else -1)))
    calls = []
    def fetch(*args, **kwargs):
        calls.append(args)
        raise AssertionError("composite reached an ordinary supplier")
    market.once(symbol=ident if demand == "forced" else None, include_viewers=True, fetcher=fetch)
    assert calls == []
    with database.begin() as db:
        assert db.get(Instrument, ident).quality != "error"
        assert not db.scalar(select(Audit).where(Audit.kind == "market_error"))


def test_composite_demand_still_routes_to_exact_target_and_old_error_is_cleared_once(database, monkeypatch):
    from alerts import live_pricing
    from alerts.config import settings
    from alerts.storage import MarketComposite, MarketDataset
    from test_market_usage import ready

    composite_id, ticker = ready(database, monkeypatch)
    with database.begin() as db:
        inst = db.get(Instrument, ticker)
        inst.quality, inst.error = "error", "Unknown source: composite"
        db.add(MarketDemand(id="live-chart", instrument_id=ticker, expires=market.now_ms()+60000))
        baseline = db.get(MarketComposite, composite_id).active_revision_id
        datasets = [(d.id, d.identity) for d in db.scalars(select(MarketDataset))]
    before = live_pricing.desired_datasets(settings.oanda_account_id)
    calls = []
    market.once(symbol=ticker, include_viewers=True, fetcher=lambda *a: calls.append(a))
    market.once(symbol=ticker, include_viewers=True, fetcher=lambda *a: calls.append(a))
    after = live_pricing.desired_datasets(settings.oanda_account_id)
    assert before == after and set(after) == {"EUR_USD"}
    assert calls == []
    with database.begin() as db:
        inst = db.get(Instrument, ticker)
        assert inst.error is None and inst.quality == "waiting" and inst.last_received is None
        assert db.get(MarketComposite, composite_id).active_revision_id == baseline
        assert [(d.id, d.identity) for d in db.scalars(select(MarketDataset))] == datasets
        assert len(db.scalars(select(Audit).where(Audit.kind == "market_routing_repaired")).all()) == 1
        assert db.get(MarketDemand, "live-chart")


def test_composite_history_jobs_are_not_created_or_dispatched(database, monkeypatch):
    monkeypatch.setattr(market.settings, "initial_history_days", 1)
    ident = "MC:history-test:EURUSD"
    with database.begin() as db:
        for inst in db.scalars(select(Instrument)):
            inst.enabled = False
        db.add(Instrument(id=ident, label="Composite", source="composite", symbol="EURUSD",
            basis="bid", calendar="ny17", precision=5, enabled=True))
        db.flush()
        assert market.queue_initial_history(db, end=172800000) == 0
        db.add(ImportJob(instrument_id=ident, start=0, end=60000, cursor=0))
    assert not market.import_once(fetcher=lambda *a: pytest.fail("composite import dispatched"))


def test_unrelated_composite_error_is_preserved(database):
    ident = "MC:other-error:EURUSD"
    with database.begin() as db:
        db.add(Instrument(id=ident, label="Composite", source="composite", symbol="EURUSD",
            basis="bid", calendar="ny17", precision=5, enabled=False,
            quality="error", error="preparation failed"))
    market.once(symbol=ident, include_viewers=True)
    with database.begin() as db:
        assert db.get(Instrument, ident).error == "preparation failed"


def test_explicit_datasets_stay_with_independent_collectors_even_when_forced(database, monkeypatch):
    from alerts.market_datasets import register_dataset
    from alerts.storage import MarketDataset
    from test_market_contracts import identity
    with database.begin() as db:
        inst = register_dataset(db, identity(), logical_symbol="EURUSD", label="Independent",
            calendar="ny17", precision=5, volume_kind="quantity", volume_unit="lots")
        inst.enabled = True
        ticker = inst.id
        assert db.scalar(select(MarketDataset).where(MarketDataset.instrument_id == ticker))
    market.once(symbol=ticker, include_viewers=True, fetcher=lambda *a: pytest.fail("explicit dataset dispatched"))
