"""Composite consumers share scoped OANDA demand and survive browser expiry."""

from alerts import live_pricing as live
from alerts.composite_definitions import first_use, save_mapping
from alerts.config import settings
from alerts.market_data import renew_demand
from alerts.storage import (
    ChartAlert,
    ChartAlertVersion,
    Instrument,
    MarketComposite,
    MarketDemand,
    Watch,
)
from sqlalchemy import func, select
from test_composite_definitions import PROOF, prepare, publish
from test_market_contracts import identity


def ready(database, monkeypatch):
    catalog = prepare(database, monkeypatch)
    monkeypatch.setattr(settings, "oanda_resident_symbols", "")
    publish(database)
    with database.begin() as db:
        mapping = save_mapping(db, identity().key, catalog, PROOF)
        composite = first_use(db, identity().key, mapping.id)
        return composite.id, composite.instrument_id


def test_first_use_and_management_create_no_demand_but_actual_chart_renews_shared_target(database, monkeypatch):
    ident, ticker = ready(database, monkeypatch)
    assert live.desired_datasets(settings.oanda_account_id) == {}
    with database.begin() as db:
        renew_demand(db, "chart-one", db.get(Instrument, ticker))
        renew_demand(db, "chart-one", db.get(Instrument, ticker))
        renew_demand(db, "chart-two", db.get(Instrument, ticker))
        assert db.scalar(select(func.count()).select_from(MarketDemand)) == 2
        assert db.get(MarketComposite, ident)
    desired = live.desired_datasets(settings.oanda_account_id)
    assert set(desired) == {"EUR_USD"}
    assert not live.desired_datasets("wrong-account")
    with database.begin() as db:
        for row in db.scalars(select(MarketDemand)):
            row.expires = 0
    assert not live.desired_datasets(settings.oanda_account_id)


def test_active_strategy_keeps_target_after_browser_closes_and_pausing_releases_it(database, monkeypatch):
    _, ticker = ready(database, monkeypatch)
    with database.begin() as db:
        watch = Watch(instrument_id=ticker, name="persistent", status="active", rule={"timeframe": "M1"},
            state={}, armed_at=0)
        db.add(watch)
        db.flush()
        ident = watch.id
    assert set(live.desired_datasets(settings.oanda_account_id)) == {"EUR_USD"}
    with database.begin() as db:
        db.get(Watch, ident).status = "paused"
    assert not live.desired_datasets(settings.oanda_account_id)


def test_current_chart_alert_version_and_expiry_own_persistent_demand(database, monkeypatch):
    _, ticker = ready(database, monkeypatch)
    with database.begin() as db:
        alert = ChartAlert(request_id="usage-test", request_hash="hash", name="persistent",
            effective_at=0, status="active", version=2)
        db.add(alert)
        db.flush()
        ident = alert.id
        db.add_all([ChartAlertVersion(alert_id=ident, version=1, config={"instrument": "unused"},
            market_identity={}, effective_at=0),
            ChartAlertVersion(alert_id=ident, version=2, config={"instrument": ticker},
            market_identity={}, effective_at=0)])
    assert set(live.desired_datasets(settings.oanda_account_id)) == {"EUR_USD"}
    with database.begin() as db:
        db.get(ChartAlert, ident).expires_at = 1
    assert not live.desired_datasets(settings.oanda_account_id)


def test_empty_residents_and_account_catalog_other_assets_idle_cleanly(database, monkeypatch):
    monkeypatch.setattr(settings, "oanda_resident_symbols", "")
    assert live.ensure_catalog([
        {"name": "EUR_USD", "type": "CURRENCY", "displayPrecision": 5},
        {"name": "US30_USD", "type": "CFD", "displayPrecision": 1},
    ], "catalog-test") == ()
    assert not live.desired_datasets("catalog-test")
    with database.begin() as db:
        instrument = db.scalar(select(Instrument).where(Instrument.symbol == "US30_USD"))
        assert instrument and not instrument.enabled
        renew_demand(db, "index-chart", instrument)
    assert set(live.desired_datasets("catalog-test")) == {"US30_USD"}
