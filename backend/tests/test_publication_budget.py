from datetime import UTC, datetime
from decimal import Decimal

from alerts import managed_dataset as managed
from alerts import market, publication_budget, storage
from alerts.chart_aggregation import aggregate_once, enqueue_aggregation
from sqlalchemy import select


def test_small_committed_history_pages_resume_to_exact_full_snapshot(database, monkeypatch):
    start = storage.ms(datetime(2026, 9, 28, tzinfo=UTC))
    now = start + 3000 * 60000 + 5000
    monkeypatch.setattr(managed, 'now_ms', lambda: now)
    monkeypatch.setattr(storage, 'now_ms', lambda: now)
    with database.begin() as db:
        inst = db.get(storage.Instrument, 'BTCUSDT')
        managed.join(db, inst, start, now)
        market.ingest(db, inst, dict(rows=[dict(timestamp=start+i*60000,
            open=10,high=11,low=9,close=10,volume=i) for i in range(3000)]),received_at=now)
    counts=[]
    for _ in range(200):
        result=managed.publish_once()
        with database.begin() as db:
            pub=db.get(storage.ChartPublication,('BTCUSDT','M1'))
            if pub:
                counts.append(pub.complete_count)
        if not result:
            break
    else:
        raise AssertionError('Small pages failed to resume')
    assert any(0 < count < 3000 for count in counts)
    with database.begin() as db:
        rows=managed.read_rows(db,db.get(storage.Instrument,'BTCUSDT'),'M1',now,4000)
        assert [row['start'] for row in rows]==[start+i*60000 for i in range(3000)]
        assert [Decimal(row['volume']) for row in rows]==list(range(3000))
        assert db.get(storage.ChartPublication,('BTCUSDT','M1')).initialized


def test_aggregation_remainder_survives_new_input_and_merges_same_window(database,monkeypatch):
    start=storage.ms(datetime(2026,9,28,tzinfo=UTC))
    now=start+1440*60000+5000
    monkeypatch.setattr(storage,'now_ms',lambda:now)
    calls=[]
    monkeypatch.setattr(market,'aggregate_touched',lambda db,inst,touched,**kwargs:
        calls.append((min(touched),max(touched),kwargs['kind'])))
    with database.begin() as db:
        db.add(storage.ChartAggregationJob(instrument_id='BTCUSDT',timeframe='M5',
            start=start,end=start+1440*60000,created_at=now-20000))
        # A remainder already persisted by an overlapping ingestion is reused.
        db.add(storage.ChartAggregationJob(instrument_id='BTCUSDT',timeframe='M5',
            start=start+120*60000,end=start+1440*60000,created_at=now,kind='observed'))
    with publication_budget.work_budget():
        assert aggregate_once()
    with database.begin() as db:
        jobs=list(db.scalars(select(storage.ChartAggregationJob)))
        assert len(jobs)==1 and jobs[0].start==start+120*60000 and jobs[0].kind=='price'
        enqueue_aggregation(db,'BTCUSDT',start,start+60000,now)
    for _ in range(30):
        with publication_budget.work_budget():
            if not aggregate_once():
                break
    with database.begin() as db:
        assert not list(db.scalars(select(storage.ChartAggregationJob)))
    assert calls[0][1] < storage.instant(start+120*60000)


def test_expired_cooperative_deadline_still_allows_one_resumable_page(monkeypatch):
    clock=[0]
    monkeypatch.setattr(publication_budget.time,'monotonic',lambda:clock[0])
    with publication_budget.work_budget() as budget:
        clock[0]=1
        assert budget.available > 0
        budget.consume(10,progressed=False)
        assert budget.available > 0
        budget.consume(1)
        assert budget.available==0


def test_unchanged_tail_cannot_starve_older_history_after_deadline(database,monkeypatch):
    start=storage.ms(datetime(2026,9,28,tzinfo=UTC))
    now=start+3000*60000+5000
    monkeypatch.setattr(managed,'now_ms',lambda:now)
    monkeypatch.setattr(storage,'now_ms',lambda:now)
    with database.begin() as db:
        inst=db.get(storage.Instrument,'BTCUSDT')
        plan=managed.join(db,inst,start+2400*60000,now)
        market.ingest(db,inst,dict(rows=[dict(timestamp=start+i*60000,
            open=10,high=11,low=9,close=10) for i in range(3000)]),received_at=now)
        managed.publish_frame(db,inst,plan,'M1',now)
        plan.target_start=start
        before=db.get(storage.ChartPublication,('BTCUSDT','M1')).start
    with publication_budget.work_budget() as budget:
        budget.deadline=-1
        with database.begin() as db:
            managed.publish_frame(db,db.get(storage.Instrument,'BTCUSDT'),
                db.get(storage.ChartHistoryPlan,'BTCUSDT'),'M1',now)
            assert db.get(storage.ChartPublication,('BTCUSDT','M1')).start < before


def test_slow_publication_does_not_starve_durable_aggregate(database,monkeypatch):
    from alerts import chart_aggregation_worker
    start=storage.ms(datetime(2026,9,28,tzinfo=UTC))
    now=start+1440*60000+5000
    monkeypatch.setattr(storage,'now_ms',lambda:now)
    with database.begin() as db:
        db.add(storage.ChartAggregationJob(instrument_id='BTCUSDT',timeframe='M5',
            start=start,end=start+120*60000,created_at=now))
    calls=[]
    monkeypatch.setattr(market,'aggregate_touched',lambda *args,**kwargs:calls.append(True))
    def slow_publish():
        budget=publication_budget.current()
        budget.consume(384)
        budget.deadline=-1
        return True
    monkeypatch.setattr(chart_aggregation_worker,'publish_once',slow_publish)
    assert chart_aggregation_worker.cycle()==(True,True)
    assert calls==[True]
