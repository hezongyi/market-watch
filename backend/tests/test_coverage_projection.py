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
            done = backfill_page(db, db.get(Instrument, 'EURUSD'), limit=1)['complete']
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
            done = backfill_page(db, db.get(Instrument, 'EURUSD'))['complete']
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
        assert not backfill_page(db, db.get(Instrument, 'BTCUSDT'), limit=1)['complete']
    with database.begin() as db:
        inst = db.get(Instrument, 'BTCUSDT')
        # A transaction commits a UUID that sorts before the saved checkpoint.
        db.add(MarketCoverage(id='a-late', instrument_id=inst.id, source=inst.source,
                              basis=inst.basis, start=180000, end=300000))
    for _ in range(5):
        with database.begin() as db:
            done = backfill_page(db, db.get(Instrument, 'BTCUSDT'), limit=1)['complete']
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
            done = backfill_page(db, db.get(Instrument, 'EURUSD'))['complete']
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
