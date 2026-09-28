from alerts.config import settings
from alerts.storage import Instrument, bootstrap
from sqlalchemy import create_engine
from sqlalchemy.orm import Session


def test_source_selection_only_affects_new_instruments(monkeypatch):
    engine = create_engine("sqlite://")
    monkeypatch.setattr(settings, "fx_source", "oanda")
    bootstrap(engine)
    with Session(engine) as db:
        assert db.get(Instrument, "EURUSD").source == "oanda"
        assert db.get(Instrument, "EURUSD").symbol == "EUR_USD"
        assert db.get(Instrument, "XAUUSD").symbol == "XAU_USD"
        assert db.get(Instrument, "BTCUSDT").source == "binance"
    monkeypatch.setattr(settings, "fx_source", "dukascopy")
    bootstrap(engine)
    with Session(engine) as db:
        assert db.get(Instrument, "EURUSD").source == "oanda"
    engine.dispose()
