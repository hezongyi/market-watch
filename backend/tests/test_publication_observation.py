"""Real observation timestamps advance without revising unchanged chart content."""

import pytest
from alerts import managed_dataset as managed
from alerts import market, storage
from alerts.chart_aggregation import aggregate_once
from sqlalchemy import select
from test_publication_scheduler import MINUTE, START


def test_rolling_observation_keeps_freshness_without_content_revisions(database, monkeypatch):
    now = START + 120 * MINUTE + 5000
    monkeypatch.setattr(storage, 'now_ms', lambda: now)
    monkeypatch.setattr(managed, 'now_ms', lambda: now)
    rows = [dict(timestamp=START+i*MINUTE, open=10, high=11, low=9, close=10)
            for i in range(120)]
    with database.begin() as db:
        inst = db.get(storage.Instrument, 'BTCUSDT')
        managed.join(db, inst, START, now)
        market.ingest(db, inst, dict(rows=rows), received_at=now)
    for _ in range(100):
        aggregate_once()
        managed.publish_once()
    with database.begin() as db:
        before = {(r.timeframe, r.start): (r.revision, r.payload) for r in
                  db.scalars(select(storage.ChartPublishedBar))}
        publication_revisions = {(r.instrument_id, r.timeframe): r.revision for r in
                                 db.scalars(select(storage.ChartPublication))}
    assert before
    assert {'M1', 'M5', 'M15', 'M30', 'H1'} <= {key[0] for key in before}
    now += 1000
    with database.begin() as db:
        market.ingest(db, db.get(storage.Instrument, 'BTCUSDT'), dict(rows=rows), received_at=now)
        assert not list(db.scalars(select(storage.ChartPublicationJob).where(
            storage.ChartPublicationJob.timeframe == 'M1')))
        minute = managed.read_rows(db, db.get(storage.Instrument, 'BTCUSDT'), 'M1', now, 1)[0]
        assert minute['observed_at'] == now
    for _ in range(100):
        aggregate_once()
        managed.publish_once()
    with database.begin() as db:
        for row in db.scalars(select(storage.ChartPublishedBar)):
            previous_revision, previous = before[row.timeframe, row.start]
            assert row.revision == previous_revision, row.timeframe
            assert row.payload['observed_at'] == now, row.timeframe
            assert {k: v for k, v in row.payload.items() if k != 'observed_at'} == {
                k: v for k, v in previous.items() if k != 'observed_at'}
        assert not list(db.scalars(select(storage.ChartPublicationJob)))
        assert {(r.instrument_id, r.timeframe): r.revision for r in
                db.scalars(select(storage.ChartPublication))} == publication_revisions


@pytest.mark.parametrize('damage', ['price', 'volume', 'confirmation', 'incomplete'])
def test_observation_never_masks_unpublished_content(database, monkeypatch, damage):
    now = START + 2 * MINUTE + 5000
    monkeypatch.setattr(storage, 'now_ms', lambda: now)
    monkeypatch.setattr(managed, 'now_ms', lambda: now)
    row = dict(timestamp=START, open=10, high=11, low=9, close=10, volume=5)
    with database.begin() as db:
        inst = db.get(storage.Instrument, 'BTCUSDT')
        managed.join(db, inst, START, now)
        market.ingest(db, inst, dict(rows=[row]), received_at=now)
    for _ in range(40):
        managed.publish_once()
    with database.begin() as db:
        published = db.get(storage.ChartPublishedBar, ('BTCUSDT', 'M1', START))
        payload = dict(published.payload)
        payload[{'price': 'high', 'volume': 'volume', 'confirmation': 'confirmed_at',
                 'incomplete': 'complete'}[damage]] = {
                     'price': '99', 'volume': '99', 'confirmation': 1, 'incomplete': False}[damage]
        published.payload = payload
        published.complete = payload['complete']
        revision = published.revision
    now += 1000
    with database.begin() as db:
        market.ingest(db, db.get(storage.Instrument, 'BTCUSDT'), dict(rows=[row]), received_at=now)
        published = db.get(storage.ChartPublishedBar, ('BTCUSDT', 'M1', START))
        assert published.payload == payload
        assert db.get(storage.ChartPublicationJob, ('BTCUSDT', 'M1', START)) is not None
    for _ in range(40):
        aggregate_once()
        managed.publish_once()
    with database.begin() as db:
        published = db.get(storage.ChartPublishedBar, ('BTCUSDT', 'M1', START))
        assert published.payload['high'] != '99' and published.payload['volume'] != '99'
        assert published.payload['complete'] and published.payload['observed_at'] == now
        assert published.payload['confirmed_at'] != 1
        assert published.revision > revision
