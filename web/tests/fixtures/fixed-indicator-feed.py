"""Genuine fixed-history pending/ready pages for native initialization redraw."""

import json

import pytest
from alerts import market_stream as stream
from alerts import storage
from alerts.chart_api import DataQuery, data_sync
from alerts.chart_series import encode
from alerts.market_stream_api import Subscription, resolve
from alerts.market_stream_worker import Calculator
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from test_fixed_indicators import drain, history
from test_market_stream import session

engine = create_engine("sqlite://", poolclass=StaticPool)
storage.bootstrap(engine)
factory = sessionmaker(engine, expire_on_commit=False)
patch = pytest.MonkeyPatch()
patch.setattr(storage, "Session", factory)
try:
    version = history(factory, patch, count=70)
    spec = {"name": "EMA", "version": "1", "params": {"period": 19}}
    query = DataQuery(instrument=version, series_kind="history", timeframe="M1", limit=12,
                      indicators=[spec], track_history=True, provisional=False)
    pending = data_sync(query)
    owner = session(factory)
    identity, serialized = resolve(Subscription(client="test", listener="test", generation=1,
        kind="bars", query=query))
    stream.register(owner, "test", "test", 1, identity, serialized, {"initial_indicator_pending": True})
    calculator, cursors = Calculator(), {}
    work = stream.claim()
    payload, _ = calculator.build(work)
    stream.commit(work, payload, delay_ms=0)
    stream.events(owner, "test", cursors)
    drain(pending["indicator_progress"][0]["run_id"])
    ready = data_sync(query)
    work = stream.claim()
    payload, _ = calculator.build(work)
    stream.commit(work, payload, delay_ms=0)
    event = stream.events(owner, "test", cursors)[0]
    print(json.dumps({"ticker": encode(version, "history"), "spec": spec, "pending": pending,
                      "ready": ready, "event": event}))
finally:
    patch.undo()
    engine.dispose()
