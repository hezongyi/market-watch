"""Ubuntu-only in-memory reproduction; never connects to production."""
import os
os.environ["ALERTS_DATABASE_URL"] = "sqlite://"
os.environ["ALERTS_DELIVERY_ENABLED"] = "false"
import json, inspect, sys, textwrap
from contextlib import contextmanager
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from alerts import market
from alerts.storage import (Base, Instrument, MarketDataset, Preference, Audit,
    ChartHistoryPlan, MarketDemand, ChartViewportDemand)

engine = create_engine("sqlite://")
Base.metadata.create_all(engine, tables=[m.__table__ for m in (
    Instrument, MarketDataset, Preference, Audit, ChartHistoryPlan,
    MarketDemand, ChartViewportDemand)])
factory = sessionmaker(engine, expire_on_commit=False)
@contextmanager
def transaction():
    with factory.begin() as db:
        yield db
market.transaction = transaction
if "--candidate-filter" in sys.argv:
    body = textwrap.dedent(inspect.getsource(market.once))
    body = body.replace("if i.id not in explicit and", "if i.source in {'dukascopy', 'oanda', 'binance'} and i.id not in explicit and")
    namespace = {}
    exec(body, market.__dict__, namespace)
    market.once = namespace["once"]
ident = "MC:b3f55bdfc39e3f5c5508371e3:EURUSD"
with transaction() as db:
    db.add(Instrument(id=ident, label="isolated composite", source="composite",
        symbol="EURUSD", basis="bid", calendar="ny17", precision=5, enabled=False))
    if "--no-demand" not in sys.argv:
        db.add(MarketDemand(id="isolated-chart-demand", instrument_id=ident,
            expires=market.now_ms()+60000))
market.once(include_viewers=True)
with transaction() as db:
    inst = db.get(Instrument, ident)
    errors = [e.details for e in db.scalars(select(Audit).where(Audit.kind == "market_error"))]
    print(json.dumps({"instrument": ident, "enabled": inst.enabled,
        "quality": inst.quality, "error": inst.error, "market_errors": errors}))
    assert inst.error != "Unknown source: composite", "composite reached ordinary provider fetch"
