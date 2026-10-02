"""Produce actual managed API responses from a disposable in-memory dataset."""

import json
from datetime import UTC, datetime

from alerts import market, storage
from alerts.chart_api import DataQuery
from alerts.managed_dataset import data, join, publish_frame
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

engine = create_engine("sqlite://", poolclass=StaticPool)
storage.bootstrap(engine)
storage.Session = sessionmaker(engine, expire_on_commit=False)
start = storage.ms(datetime(2026, 9, 28, tzinfo=UTC))
minute = 60000
end = start + 20 * minute
now = end + 5000


def ingest(left, count, price=10):
    payload = {"source": "binance", "basis": "last", "rows": [
        dict(timestamp=left + i * minute, open=price, high=price + 1, low=price - 1, close=price)
        for i in range(count)
    ]}
    with storage.Session.begin() as db:
        inst = db.get(storage.Instrument, "BTCUSDT")
        plan = join(db, inst, start - 10 * minute, now)
        market.ingest(db, inst, payload, received_at=now)
        publish_frame(db, inst, plan, "M1", now)


ingest(start, 20)
body = DataQuery(instrument="BTCUSDT", timeframe="M1", published=True, limit=3,
                 track_history=True, dataset_start=start, revision_after=start, before=end)
initial = data(body)
body.revision_before = initial["history_check"]["next_before"]
ingest(start - 10 * minute, 10)
expanded = data(body)
ingest(end - 2 * minute, 1, 30)
corrected = data(body)
print(json.dumps(dict(start=start, initial=initial, expanded=expanded, corrected=corrected)))
engine.dispose()
