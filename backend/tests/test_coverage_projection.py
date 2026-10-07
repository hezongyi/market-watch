"""Legacy proof preservation through the published coverage read interface."""

from alerts import market
from alerts.storage import Audit, Instrument, MarketCoverage
from sqlalchemy import event


def test_projection_keeps_legacy_margin_and_unknown_gap_without_audit_reads(database):
    from alerts.coverage_projection import backfill_page

    with database.begin() as db:
        inst = db.get(Instrument, 'EURUSD')
        inst.source = 'oanda'
        db.add(MarketCoverage(instrument_id=inst.id, source='oanda', basis=inst.basis,
                              start=0, end=120000))
        db.add(Audit(kind='provider_query_coverage', details=dict(
            instrument=inst.id, basis=inst.basis, received_at=245000,
            ranges=[dict(start=120001, end=360000)])))
    # Restartable page calls have independent transactions. Legacy missing
    # source/bounds follows the recorded old OANDA contract, not current time.
    for _ in range(10):
        with database.begin() as db:
            done = backfill_page(db, db.get(Instrument, 'EURUSD'), limit=1, administrative=True)['complete']
        if done:
            break
    assert done
    statements = []
    engine = database.kw['bind']
    def record(conn, cursor, statement, parameters, context, many):
        statements.append(statement)
    event.listen(engine, 'before_cursor_execute', record)
    try:
        with database.begin() as db:
            assert market.stored_coverage(db, db.get(Instrument, 'EURUSD'), 0, 600000) == [
                {'start': 0, 'end': 120000}, {'start': 180000, 'end': 240000}]
    finally:
        event.remove(engine, 'before_cursor_execute', record)
    assert not any('FROM audit' in statement for statement in statements)


def test_wrong_source_and_malformed_legacy_proofs_never_certify_coverage(database):
    with database.begin() as db:
        inst = db.get(Instrument, 'EURUSD')
        inst.source = 'oanda'
        common = dict(instrument=inst.id, basis=inst.basis, received_at=245000,
                      ranges=[dict(start=0, end=240000)])
        db.add(Audit(kind='provider_query_coverage', details={**common, 'source': 'binance'}))
        db.add(Audit(kind='provider_query_coverage', details={**common, 'range_start': 'invalid',
            'ranges': [dict(start='invalid', end=240000)]}))
    with database.begin() as db:
        assert market.stored_coverage(db, db.get(Instrument, 'EURUSD'), 0, 600000) == []
    from alerts.coverage_projection import backfill_page
    from alerts.storage import MarketCoverageQuarantine
    from sqlalchemy import select
    for _ in range(5):
        with database.begin() as db:
            done = backfill_page(db, db.get(Instrument, 'EURUSD'), administrative=True)['complete']
        if done:
            break
    assert done
    with database.begin() as db:
        assert market.stored_coverage(db, db.get(Instrument, 'EURUSD'), 0, 600000) == []
        assert len(list(db.scalars(select(MarketCoverageQuarantine)))) == 2


def test_checkpoint_catches_late_uuid_behind_cursor_and_proof_removal(database):
    from alerts.coverage_projection import backfill_page, rebuild
    with database.begin() as db:
        inst = db.get(Instrument, 'BTCUSDT')
        db.add(MarketCoverage(id='z-first', instrument_id=inst.id, source=inst.source,
                              basis=inst.basis, start=0, end=120000))
    with database.begin() as db:
        assert not backfill_page(db, db.get(Instrument, 'BTCUSDT'), limit=1, administrative=True)['complete']
    with database.begin() as db:
        inst = db.get(Instrument, 'BTCUSDT')
        # A transaction commits a UUID that sorts before the saved checkpoint.
        db.add(MarketCoverage(id='a-late', instrument_id=inst.id, source=inst.source,
                              basis=inst.basis, start=180000, end=300000))
    for _ in range(5):
        with database.begin() as db:
            done = backfill_page(db, db.get(Instrument, 'BTCUSDT'), limit=1, administrative=True)['complete']
        if done:
            break
    assert done
    with database.begin() as db:
        inst = db.get(Instrument, 'BTCUSDT')
        assert market.stored_coverage(db, inst, 0, 600000) == [
            dict(start=0, end=120000), dict(start=180000, end=300000)]
        db.delete(db.get(MarketCoverage, 'z-first'))
        result = rebuild(db, inst)
        assert result['complete']
        assert market.stored_coverage(db, inst, 0, 600000) == [dict(start=180000, end=300000)]


def test_completed_projection_dual_writes_new_proof_and_can_return_to_compatibility(database, monkeypatch):
    from alerts.coverage_projection import backfill_page
    with database.begin() as db:
        inst = db.get(Instrument, 'EURUSD')
        inst.source = 'oanda'
        market.ingest(db, inst, {'rows': [], 'coverage': [dict(start=0, end=120000)]}, received_at=245000)
    for _ in range(5):
        with database.begin() as db:
            done = backfill_page(db, db.get(Instrument, 'EURUSD'), administrative=True)['complete']
        if done:
            break
    assert done
    with database.begin() as db:
        inst = db.get(Instrument, 'EURUSD')
        market.ingest(db, inst, {'rows': [], 'coverage': [dict(start=180000, end=240000)]}, received_at=245000)
        expected = [dict(start=0, end=120000), dict(start=180000, end=240000)]
        assert market.stored_coverage(db, inst, 0, 600000) == expected
        monkeypatch.setattr(market.settings, 'coverage_projection_enabled', False)
        assert {(span['start'], span['end']) for span in market.stored_coverage(db, inst, 0, 600000)} == {
            (0, 120000), (180000, 240000)}


def test_explicit_proof_removal_retracts_sparse_published_hour(database, monkeypatch):
    from alerts import managed_dataset as managed
    from alerts import storage
    from alerts.chart_aggregation import aggregate_once
    from alerts.coverage_projection import rebuild
    from sqlalchemy import select
    from test_publication_scheduler import MINUTE, START
    now = START + 60 * MINUTE + 5000
    monkeypatch.setattr(managed, 'now_ms', lambda: now)
    monkeypatch.setattr(storage, 'now_ms', lambda: now)
    with database.begin() as db:
        inst = db.get(Instrument, 'BTCUSDT')
        managed.join(db, inst, START, now)
        market.ingest(db, inst, {'rows': [dict(timestamp=START, open=10, high=11, low=9, close=10)]}, received_at=now)
        proof = MarketCoverage(id='sparse-hour', instrument_id=inst.id, source=inst.source,
            basis=inst.basis, start=START, end=START + 60 * MINUTE)
        db.add(proof)
        db.flush()
        market.aggregate_touched(db, inst, {storage.instant(START)}, received_at=now)
    for _ in range(40):
        aggregate_once()
        managed.publish_once()
    with database.begin() as db:
        inst = db.get(Instrument, 'BTCUSDT')
        assert managed.read_rows(db, inst, 'H1', now, 1)[0]['complete']
        db.delete(db.get(MarketCoverage, 'sparse-hour'))
        rebuild(db, inst)
    for _ in range(40):
        aggregate_once()
        managed.publish_once()
    with database.begin() as db:
        inst = db.get(Instrument, 'BTCUSDT')
        source = db.scalar(select(storage.Bar).where(storage.Bar.instrument_id == inst.id,
            storage.Bar.timeframe == 'H1'))
        assert not source.complete
        assert not managed.read_rows(db, inst, 'H1', now, 1)[0]['complete']
        assert managed.status(db, inst, 'H1')['complete_count'] == 0
        # Repeated maintenance does not fabricate count/revision changes.
        pub = db.get(storage.ChartPublication, (inst.id, 'H1'))
        revision = pub.revision
        rebuild(db, inst)
        assert pub.complete_count == 0 and pub.revision == revision
        db.add(MarketCoverage(id='restored-hour', instrument_id=inst.id, source=inst.source,
            basis=inst.basis, start=START, end=START + 60 * MINUTE))
        rebuild(db, inst)
    for _ in range(40):
        aggregate_once()
        managed.publish_once()
    with database.begin() as db:
        inst = db.get(Instrument, 'BTCUSDT')
        assert managed.read_rows(db, inst, 'H1', now, 1)[0]['complete']
        assert managed.status(db, inst, 'H1')['complete_count'] == 1


def test_publisher_pages_never_run_full_raw_proof_verification(database):
    from alerts.coverage_projection import backfill_page
    from alerts.storage import MarketCoverageCheckpoint
    from sqlalchemy import select
    with database.begin() as db:
        inst = db.get(Instrument, 'BTCUSDT')
        db.add_all([MarketCoverage(id=str(i), instrument_id=inst.id, source=inst.source,
            basis=inst.basis, start=i * 120000, end=i * 120000 + 60000) for i in range(10)])
    queries = []
    def record(conn, cursor, statement, parameters, context, many):
        queries.append(statement)
    engine = database.kw['bind']
    event.listen(engine, 'before_cursor_execute', record)
    try:
        for _ in range(20):
            with database.begin() as db:
                result = backfill_page(db, db.get(Instrument, 'BTCUSDT'), limit=2)
                assert result['examined'] <= 2
                assert not result['complete']
            if result.get('maintenance_required'):
                break
        assert result.get('maintenance_required')
        assert all('LIMIT' in q for q in queries if 'FROM market_data_coverage' in q)
        with database.begin() as db:
            state = db.scalar(select(MarketCoverageCheckpoint))
            assert not state.complete and state.phase == 'verify'
            verified = backfill_page(db, db.get(Instrument, 'BTCUSDT'), limit=2, administrative=True)
            assert verified['complete'] and verified['examined'] == 10
    finally:
        event.remove(engine, 'before_cursor_execute', record)


def test_explicit_verify_rechecks_completed_projection_after_old_writer(database):
    from alerts.coverage_projection import backfill_page
    with database.begin() as db:
        inst = db.get(Instrument, 'BTCUSDT')
        db.add(MarketCoverage(id='first', instrument_id=inst.id, source=inst.source,
                              basis=inst.basis, start=0, end=120000))
    for _ in range(5):
        with database.begin() as db:
            done = backfill_page(db, db.get(Instrument, 'BTCUSDT'), administrative=True)['complete']
        if done:
            break
    assert done
    with database.begin() as db:
        inst = db.get(Instrument, 'BTCUSDT')
        # The additive schema survives application rollback; old code writes raw proof only.
        db.add(MarketCoverage(id='old-writer', instrument_id=inst.id, source=inst.source,
                              basis=inst.basis, start=120000, end=240000))
    with database.begin() as db:
        inst = db.get(Instrument, 'BTCUSDT')
        result = backfill_page(db, inst, administrative=True)
        assert result['complete'] and result['examined'] == 2
        assert market.stored_coverage(db, inst, 0, 300000) == [dict(start=0,end=240000)]
