"""Publication behavior through persistent ingestion and published reader seams."""

from datetime import UTC, datetime

from alerts import managed_dataset as managed
from alerts import market, storage
from alerts.managed_dataset import join, read_rows, status
from alerts.storage import Instrument, ms
from sqlalchemy import event

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


def test_idle_ready_check_does_not_read_source_history(database, monkeypatch):
    now = START + 30 * MINUTE + 5000
    monkeypatch.setattr(managed, 'now_ms', lambda: now)
    monkeypatch.setattr(storage, 'now_ms', lambda: now)
    with database.begin() as db:
        inst = db.get(Instrument, 'BTCUSDT')
        join(db, inst, START, now)
        market.ingest(db, inst, {'rows': [
            dict(timestamp=START + i * MINUTE, open=10, high=11, low=9, close=10)
            for i in range(30)]}, received_at=now)
    for _ in range(3 * len(managed.FRAMES)):
        managed.publish_once()
    # SQL is an external work-budget observation, not a mocked collaborator.
    reads = []
    engine = database.kw['bind']

    def record(conn, cursor, statement, parameters, context, many):
        if 'FROM candles' in statement:
            reads.append(statement)

    event.listen(engine, 'before_cursor_execute', record)
    try:
        for _ in managed.FRAMES:
            managed.publish_once()
    finally:
        event.remove(engine, 'before_cursor_execute', record)
    assert not reads, 'Idle ready checks must not reconstruct unchanged history'


def test_same_price_new_observation_wakes_only_its_persisted_snapshot(database, monkeypatch):
    now = START + 30 * MINUTE + 5000
    monkeypatch.setattr(managed, 'now_ms', lambda: now)
    monkeypatch.setattr(storage, 'now_ms', lambda: now)
    rows = [dict(timestamp=START + i * MINUTE, open=10, high=11, low=9, close=10)
            for i in range(30)]
    with database.begin() as db:
        inst = db.get(Instrument, 'BTCUSDT')
        join(db, inst, START, now)
        market.ingest(db, inst, {'rows': rows}, received_at=now)
    for _ in range(3 * len(managed.FRAMES)):
        managed.publish_once()
    now += 1000
    with database.begin() as db:
        market.ingest(db, db.get(Instrument, 'BTCUSDT'), {'rows': rows[-1:]}, received_at=now)
    progressed = False
    for _ in managed.FRAMES:
        result = managed.publish_once()
        progressed |= result.snapshot_changed
        with database.begin() as db:
            visible = read_rows(db, db.get(Instrument, 'BTCUSDT'), 'M1', now, 1)[0]
        if visible['observed_at'] == now:
            break
    assert progressed and visible['observed_at'] == now
    assert float(visible['close']) == 10


def test_single_observation_does_not_reload_a_full_published_history_page(database, monkeypatch):
    from sqlalchemy.orm import Session

    now = START + 2400 * MINUTE + 5000
    monkeypatch.setattr(managed, 'now_ms', lambda: now)
    monkeypatch.setattr(storage, 'now_ms', lambda: now)
    with database.begin() as db:
        inst = db.get(Instrument, 'BTCUSDT')
        join(db, inst, START, now)
        market.ingest(db, inst, {'rows': [
            dict(timestamp=START + i * MINUTE, open=10, high=11, low=9, close=10)
            for i in range(2400)]}, received_at=now)
        plan = db.get(storage.ChartHistoryPlan, inst.id)
        for _ in range(3):
            managed.publish_frame(db, inst, plan, 'M1', now)
    now += 1000
    with database.begin() as db:
        market.ingest(db, db.get(Instrument, 'BTCUSDT'), {'rows': [
            dict(timestamp=now - 5000 - 1000 - MINUTE, open=10, high=11, low=9, close=10)]}, received_at=now)
    returned = []

    def observe(query):
        result = query.invoke_statement()
        if query.is_select and 'FROM candles' in str(query.statement):
            snapshot = result.freeze()
            returned.append(len(snapshot.data))
            return snapshot()
        return result

    event.listen(Session, 'do_orm_execute', observe, retval=True)
    try:
        with database.begin() as db:
            inst = db.get(Instrument, 'BTCUSDT')
            managed.publish_frame(db, inst, db.get(storage.ChartHistoryPlan, inst.id), 'M1', now)
            assert read_rows(db, inst, 'M1', now, 1)[0]['observed_at'] == now
    finally:
        event.remove(Session, 'do_orm_execute', observe)
    assert sum(returned) <= 10, 'One changed minute must not reload thousands of unchanged source bars'


def test_low_frequency_reconciliation_recovers_a_missed_request_for_existing_dirty_bucket(database, monkeypatch):
    from alerts import publication_schedule as schedule
    from alerts.storage import ChartPublicationState
    from sqlalchemy import update

    elapsed = [100]
    monkeypatch.setattr(schedule.time, 'monotonic', lambda: elapsed[0])
    now = START + 30 * MINUTE + 5000
    monkeypatch.setattr(managed, 'now_ms', lambda: now)
    monkeypatch.setattr(storage, 'now_ms', lambda: now)
    with database.begin() as db:
        inst = db.get(Instrument, 'BTCUSDT')
        join(db, inst, START, now)
        market.ingest(db, inst, {'rows': [
            dict(timestamp=START + i * MINUTE, open=10, high=11, low=9, close=10)
            for i in range(30)]}, received_at=now)
    for _ in range(3 * len(managed.FRAMES)):
        managed.publish_once()
    now += 1000
    with database.begin() as db:
        market.ingest(db, db.get(Instrument, 'BTCUSDT'), {'rows': [
            dict(timestamp=START + 29 * MINUTE, open=10, high=11, low=9, close=10)]}, received_at=now)
        # An older application writes bucket jobs without the new state table.
        # Preserve that dirty job but remove its new wakeup, reproducing a missed
        # event without mocking either publication or the published reader.
        db.execute(update(ChartPublicationState).values(
            processed=ChartPublicationState.requested, next_at=None))
    assert not managed.publish_once()
    elapsed[0] += 61
    for _ in range(len(managed.FRAMES)):
        managed.publish_once()
    with database.begin() as db:
        assert read_rows(db, db.get(Instrument, 'BTCUSDT'), 'M1', now, 1)[0]['observed_at'] == now


def test_same_price_minute_observation_refreshes_matching_hour_without_price_revision(database, monkeypatch):
    from alerts.chart_aggregation import aggregate_once
    from sqlalchemy import select
    now = START + 60 * MINUTE + 5000
    monkeypatch.setattr(managed, 'now_ms', lambda: now)
    monkeypatch.setattr(storage, 'now_ms', lambda: now)
    with database.begin() as db:
        inst = db.get(Instrument, 'BTCUSDT')
        join(db, inst, START, now)
        market.ingest(db, inst, {'rows': [
            dict(timestamp=START + i * MINUTE, open=10, high=11, low=9, close=10)
            for i in range(60)]}, received_at=now)
    for _ in range(40):
        managed.publish_once()
    with database.begin() as db:
        inst = db.get(Instrument, 'BTCUSDT')
        before = read_rows(db, inst, 'H1', now, 1)[0]
        revision = db.scalar(select(storage.Bar.revision).where(
            storage.Bar.instrument_id == inst.id, storage.Bar.timeframe == 'H1'))
    now += 1000
    with database.begin() as db:
        market.ingest(db, db.get(Instrument, 'BTCUSDT'), {'rows': [
            dict(timestamp=START + 59 * MINUTE, open=10, high=11, low=9, close=10)]}, received_at=now)
    observed = now
    now += 10000  # Delay the worker; calculation time cannot invent freshness.
    for _ in range(40):
        aggregate_once()
        managed.publish_once()
    with database.begin() as db:
        inst = db.get(Instrument, 'BTCUSDT')
        after = read_rows(db, inst, 'H1', now, 1)[0]
        assert after['observed_at'] == observed
        assert {k: v for k, v in after.items() if k != 'observed_at'} == {
            k: v for k, v in before.items() if k != 'observed_at'}
        assert db.scalar(select(storage.Bar.revision).where(
            storage.Bar.instrument_id == inst.id, storage.Bar.timeframe == 'H1')) == revision


def test_restart_catches_up_more_than_one_source_page_without_further_input(database, monkeypatch):
    now = START + 30 * MINUTE + 5000
    monkeypatch.setattr(managed, 'now_ms', lambda: now)
    monkeypatch.setattr(storage, 'now_ms', lambda: now)
    with database.begin() as db:
        inst = db.get(Instrument, 'BTCUSDT')
        join(db, inst, START, now)
        market.ingest(db, inst, {'rows': [dict(timestamp=START + i * MINUTE,
            open=10, high=11, low=9, close=10) for i in range(30)]}, received_at=now)
    for _ in range(40):
        managed.publish_once()
    now = START + 2430 * MINUTE + 5000
    with database.begin() as db:
        # This is one committed input while the publisher is offline. Restore
        # requires all minutes, even when no later source event arrives.
        market.ingest(db, db.get(Instrument, 'BTCUSDT'), {'rows': [
            dict(timestamp=START + i * MINUTE, open=10, high=11, low=9, close=10)
            for i in range(30, 2430)]}, received_at=now)
    for _ in range(100):
        if not managed.publish_once():
            break
    with database.begin() as db:
        inst = db.get(Instrument, 'BTCUSDT')
        rows = read_rows(db, inst, 'M1', now, 3000)
        assert len(rows) == 2430
        assert rows[-1]['start'] == START + 2429 * MINUTE
        assert status(db, inst, 'M1')['complete_count'] == 2430


def test_incomplete_older_source_bucket_does_not_keep_publication_runnable(database, monkeypatch):
    from sqlalchemy import select
    now = START + 120 * MINUTE + 5000
    monkeypatch.setattr(managed, 'now_ms', lambda: now)
    monkeypatch.setattr(storage, 'now_ms', lambda: now)
    with database.begin() as db:
        inst = db.get(Instrument, 'BTCUSDT')
        join(db, inst, START, now)
        market.ingest(db, inst, {'rows': [dict(timestamp=START+i*MINUTE,
            open=10, high=11, low=9, close=10) for i in range(120)]}, received_at=now)
    for _ in range(40):
        managed.publish_once()
    with database.begin() as db:
        inst = db.get(Instrument, 'BTCUSDT')
        pub = db.get(storage.ChartPublication, (inst.id, 'M30'))
        # First visible half-hour has been copied; an older incomplete M15
        # source member exists but cannot produce a confirmed target bucket.
        pub.start = START + 30 * MINUTE
        db.query(storage.ChartPublishedBar).filter(
            storage.ChartPublishedBar.instrument_id == inst.id,
            storage.ChartPublishedBar.timeframe == 'M30',
            storage.ChartPublishedBar.start == START).delete()
        pub.complete_count -= 1
        source = db.scalar(select(storage.Bar).where(storage.Bar.instrument_id == inst.id,
            storage.Bar.timeframe == 'M15', storage.Bar.start == START))
        source.complete = False
        plan = db.get(storage.ChartHistoryPlan, inst.id)
        result = managed.publish_frame(db, inst, plan, 'M30', now)
        assert pub.start == START + 30 * MINUTE
        assert not result.runnable_remaining, 'Unavailable older target bucket must await new evidence'


def test_fixed_clock_continuously_runnable_target_does_not_starve_other_ready_targets(database, monkeypatch):
    from alerts.publication_result import PublicationResult
    now = START + 30 * MINUTE + 5000
    monkeypatch.setattr(managed, 'now_ms', lambda: now)
    monkeypatch.setattr(storage, 'now_ms', lambda: now)
    with database.begin() as db:
        for ident in ('BTCUSDT', 'EURUSD'):
            inst = db.get(Instrument, ident)
            join(db, inst, START, now)
    served = []
    def publish(db, inst, plan, frame, stamp):
        served.append((inst.id, frame))
        return PublicationResult(runnable_remaining=True)
    monkeypatch.setattr(managed, 'publish_frame', publish)
    for _ in range(2 * 18):
        managed.publish_once()
    assert len(set(served[:18])) == 18
    assert len(set(served[18:36])) == 18, 'Fixed observation clock must preserve fair worker turns'
