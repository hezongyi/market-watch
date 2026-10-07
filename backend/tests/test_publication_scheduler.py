"""Publication behavior through persistent ingestion and published reader seams."""

from datetime import UTC, datetime

from alerts import managed_dataset as managed, market, storage
from alerts.managed_dataset import join, read_rows, status
from alerts.storage import Instrument, ms

START = ms(datetime(2026, 9, 28, tzinfo=UTC))
MINUTE = 60000


def test_finished_publication_enters_wait_without_rewriting_visible_snapshot(database, monkeypatch):
    now = START + 30 * MINUTE + 5000
    monkeypatch.setattr(managed, 'now_ms', lambda: now)
    monkeypatch.setattr(storage, 'now_ms', lambda: now)
    with database.begin() as db:
        inst = db.get(Instrument, 'BTCUSDT')
        join(db, inst, START, now)
        market.ingest(db, inst, {'rows': [
            dict(timestamp=START + i * MINUTE, open=10, high=11, low=9, close=10)
            for i in range(30)]}, received_at=now)
    # Bootstrap all periods and allow a harmless duplicate pass. A publication
    # is drained when no changed input or due work remains, regardless of timing.
    for _ in range(3 * len(managed.FRAMES)):
        managed.publish_once()
    with database.begin() as db:
        inst = db.get(Instrument, 'BTCUSDT')
        before = {frame: (read_rows(db, inst, frame, now, 100), status(db, inst, frame))
                  for frame in managed.FRAMES}
    result = managed.publish_once()
    with database.begin() as db:
        inst = db.get(Instrument, 'BTCUSDT')
        after = {frame: (read_rows(db, inst, frame, now, 100), status(db, inst, frame))
                 for frame in managed.FRAMES}
    assert before == after
    assert not result, 'An idle target is not progress and must allow worker waiting'
