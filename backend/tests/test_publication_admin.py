"""Rollback preparations expose dirty observations to the previous worker protocol."""

from alerts import managed_dataset as managed
from alerts import market, storage
from test_publication_scheduler import MINUTE, START


def test_rollback_prepares_restartable_old_bucket_jobs_without_changing_snapshot(database, monkeypatch):
    now = START + 30 * MINUTE + 5000
    monkeypatch.setattr(managed, 'now_ms', lambda: now)
    monkeypatch.setattr(storage, 'now_ms', lambda: now)
    with database.begin() as db:
        inst = db.get(storage.Instrument, 'BTCUSDT')
        managed.join(db, inst, START, now)
        market.ingest(db, inst, {'rows': [
            dict(timestamp=START + i * MINUTE, open=10, high=11, low=9, close=10)
            for i in range(30)]}, received_at=now)
    for _ in range(40):
        managed.publish_once()
    with database.begin() as db:
        inst = db.get(storage.Instrument, 'BTCUSDT')
        before = managed.read_rows(db, inst, 'M1', now, 100)
    now += 1000
    with database.begin() as db:
        market.ingest(db, db.get(storage.Instrument, 'BTCUSDT'), {'rows': [
            dict(timestamp=START + MINUTE, open=10, high=11, low=9, close=10)]}, received_at=now)
        # Simulate loss of newer request metadata, which the previous binary
        # doesn't understand. Preparation must recover from actual snapshots.
        db.query(storage.ChartPublicationJob).delete()
    from alerts.publication_admin import prepare_rollback_page
    cursor = -1
    for _ in range(20):
        with database.begin() as db:
            result = prepare_rollback_page(db, db.get(storage.Instrument, 'BTCUSDT'), 'M1', after=cursor, limit=3)
        cursor = result['after']
        if result['complete']:
            break
    assert result['complete']
    with database.begin() as db:
        inst = db.get(storage.Instrument, 'BTCUSDT')
        assert managed.read_rows(db, inst, 'M1', now, 100) == before
        # The old correction protocol requires only existing bucket jobs.
        pub = db.get(storage.ChartPublication, (inst.id, 'M1'))
        result = managed.publish_corrections(db, inst, pub, 'M1', pub.start, pub.end, [], now)
        assert result.snapshot_changed
        assert managed.read_rows(db, inst, 'M1', now, 100)[1]['observed_at'] == now
