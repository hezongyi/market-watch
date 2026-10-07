"""Genuine fixed-history pending/ready pages for native initialization redraw."""

import json

import pytest
from alerts import storage
from alerts.chart_api import DataQuery, data_sync
from alerts.chart_series import encode
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from test_fixed_indicators import drain, history

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
    drain(pending["indicator_progress"][0]["run_id"])
    ready = data_sync(query)
    print(json.dumps({"ticker": encode(version, "history"), "spec": spec, "pending": pending, "ready": ready}))
finally:
    patch.undo()
    engine.dispose()
