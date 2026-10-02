from decimal import Decimal as D

import httpx
from alerts import provider_chart
from alerts.market import ingest
from alerts.storage import Bar, Instrument
from sqlalchemy import select


def test_native_volume_preserves_decimal_and_zero():
    meta = dict(source='binance', symbol='BTCUSDT', calendar='utc0', basis='last', precision=2)
    def handle(request):
        return httpx.Response(200, json=[
            [0, '10', '11', '9', '10', '0.123456789123456789', 59999],
            [60000, '10', '11', '9', '10', '0', 119999]])
    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        page = provider_chart.native_page(meta, 'M1', 180000, 3, client=client)
    assert [b.get('volume') for b in page['bars']] == ['0.123456789123456789', '0']
    assert all(b['volume_complete'] for b in page['bars'])


def test_volume_only_ingest_preserves_price_and_duplicate_is_noop(database):
    rows = [dict(timestamp=i*60000, open='10', high='11', low='9', close='10') for i in range(5)]
    with database.begin() as db:
        inst = db.get(Instrument, 'BTCUSDT')
        ingest(db, inst, {'rows': rows}, received_at=305000)
        m5 = db.scalar(select(Bar).where(Bar.timeframe == 'M5'))
        before = (m5.complete, m5.revision, m5.received_at)
        ingest(db, inst, {'rows': [{**r, 'volume': '2'} for r in rows]},
               received_at=365000, defer_aggregation=True)
        assert (m5.complete, m5.revision, m5.received_at) == before
        assert m5.complete
    from alerts.chart_aggregation import aggregate_once
    while aggregate_once():
        pass
    with database.begin() as db:
        m5 = db.scalar(select(Bar).where(Bar.timeframe == 'M5'))
        assert m5.volume == D('10') and m5.volume_complete
        revision = m5.volume_revision
        ingest(db, db.get(Instrument, 'BTCUSDT'), {'rows': [{**r, 'volume': '2'} for r in rows]},
               received_at=425000, defer_aggregation=True)
        assert m5.volume_revision == revision
        assert (m5.complete, m5.revision, m5.received_at) == before


def test_known_volume_survives_legacy_but_price_correction_invalidates(database):
    from alerts.domain import Candle
    from alerts.market import upsert
    from alerts.storage import instant
    with database.begin() as db:
        c = Candle(instant(0), instant(60000), D(10), D(11), D(9), D(10), volume=D(0))
        r = upsert(db, 'BTCUSDT', 'M1', c)
        revision = r.volume_revision
        upsert(db, 'BTCUSDT', 'M1', Candle(c.start, c.end, c.open, c.high, c.low, c.close))
        assert r.volume == 0 and r.volume_revision == revision
        upsert(db, 'BTCUSDT', 'M1', Candle(c.start, c.end, c.open, D(12), c.low, c.close))
        assert r.volume is None and not r.volume_complete


def test_volume_job_conflicts_missing_and_cancellation_are_durable(database):
    from alerts import volume_jobs
    from alerts.domain import Candle
    from alerts.market import upsert
    from alerts.storage import VolumeBackfillJob, VolumeBackfillSegment, instant
    with database.begin() as db:
        for i in range(3):
            upsert(db, 'BTCUSDT', 'M1', Candle(instant(i*60000), instant((i+1)*60000),
                D(10), D(11), D(9), D(10)))
        job = volume_jobs.create(db, 'BTCUSDT', start=0, end=180000)
        ident = job.id
    def response(*args):
        return dict(source='binance', basis='last', instrument='BTCUSDT', rows=[
            dict(timestamp=0, open='10', high='11', low='9', close='10', volume='3'),
            dict(timestamp=60000, open='10', high='12', low='9', close='10', volume='9')])
    assert volume_jobs.once(response)
    with database.begin() as db:
        assert db.get(VolumeBackfillJob, ident).status == 'pending'
        assert {'resolved', 'conflict', 'unreachable'} <= set(db.scalars(select(VolumeBackfillSegment.status)))
        volume_jobs.control(db, ident, 'retry')
    def cancelled(*args):
        with database.begin() as db:
            volume_jobs.control(db, ident, 'cancel')
        return dict(source='binance', basis='last', instrument='BTCUSDT', rows=[
            dict(timestamp=60000, open='10', high='11', low='9', close='10', volume='9')])
    assert volume_jobs.once(cancelled)
    with database.begin() as db:
        assert db.get(VolumeBackfillJob, ident).status == 'cancelled'
        bars = list(db.scalars(select(Bar).where(Bar.timeframe == 'M1').order_by(Bar.start)))
        assert bars[0].volume == 3 and bars[1].volume is None and bars[1].high == 11


def test_quantity_range_and_tick_rules():
    import pytest
    from alerts.volume import quantity
    for bad in ('NaN', 'Infinity', '-1', '1e20', '0.0000000000000000001'):
        with pytest.raises(ValueError):
            quantity(bad)
    with pytest.raises(ValueError):
        quantity('1.5', tick=True)
    assert quantity('99999999999999999999.999999999999999999') == D('99999999999999999999.999999999999999999')


def test_completed_price_plan_volume_authorization_does_not_resume_cancelled(database):
    import pytest
    from alerts import volume_jobs
    from alerts.storage import ChartHistoryPlan, VolumeBackfillJob
    rows = [dict(timestamp=i*60000, open='10', high='11', low='9', close='10') for i in range(5)]
    with database.begin() as db:
        inst = db.get(Instrument, 'BTCUSDT')
        ingest(db, inst, {'rows': rows}, received_at=305000)
        plan = ChartHistoryPlan(instrument_id=inst.id, target_start=0, target_end=300000,
                                status='complete', realtime_enabled=True)
        db.add(plan)
        db.flush()
        j = volume_jobs.create(db, inst.id, automatic=True, now=365000)
        assert j and plan.status == 'complete'
        volume_jobs.control(db, j.id, 'cancel')
        plan.status = 'cancelled'
        assert volume_jobs.create(db, inst.id, automatic=True, now=365000) is None
        plan.status = 'complete'
        plan.realtime_enabled = False
        assert volume_jobs.create(db, inst.id, automatic=True, now=365000) is None
        assert db.get(VolumeBackfillJob, j.id).status == 'cancelled'
        with pytest.raises(ValueError):
            volume_jobs.create(db, inst.id, start=-60000, end=300000, now=365000)


def test_missing_member_never_reports_partial_closed_total(database):
    rows = [dict(timestamp=i*60000, open='10', high='11', low='9', close='10',
                 **({'volume': '2'} if i != 2 else {})) for i in range(5)]
    with database.begin() as db:
        ingest(db, db.get(Instrument, 'BTCUSDT'), {'rows': rows}, received_at=305000)
        m5 = db.scalar(select(Bar).where(Bar.timeframe == 'M5'))
        assert m5.complete and m5.volume is None and not m5.volume_complete


def test_volume_task_does_not_hide_prices_while_pending(database):
    from alerts.chart_data import chart_rows
    rows = [dict(timestamp=i*60000, open='10', high='11', low='9', close='10') for i in range(5)]
    with database.begin() as db:
        inst = db.get(Instrument, 'BTCUSDT')
        ingest(db, inst, {'rows': rows}, received_at=305000)
        ingest(db, inst, {'rows': [{**r, 'volume': '2'} for r in rows]}, received_at=365000,
               defer_aggregation=True)
        rows = chart_rows(db, inst, 'M5', 365000, 10, 365000)
        assert rows[0]['complete'] and not rows[0].get('pending_aggregation')


def test_no_plan_volume_cannot_claim_unpublished_history_complete(database):
    from alerts import volume_jobs
    from alerts.chart_aggregation import aggregate_once
    from alerts.domain import Candle
    from alerts.market import upsert
    from alerts.storage import VolumeBackfillJob, instant
    with database.begin() as db:
        upsert(db, 'BTCUSDT', 'M1', Candle(instant(0), instant(60000), D(10), D(11), D(9), D(10)))
        ident = volume_jobs.create(db, 'BTCUSDT', start=0, end=60000).id
    volume_jobs.once(lambda *a: dict(source='binance', basis='last', rows=[
        dict(timestamp=0, open=10, high=11, low=9, close=10, volume=2)]))
    while aggregate_once():
        pass
    with database.begin() as db:
        volume_jobs.finish(db, db.get(VolumeBackfillJob, ident))
        assert db.get(VolumeBackfillJob, ident).status == 'partial'
        assert '发布快照' in db.get(VolumeBackfillJob, ident).error


def test_bridging_jobs_merge_all_overlaps_and_revoke_owners(database):
    from alerts import volume_jobs
    from alerts.domain import Candle
    from alerts.market import upsert
    from alerts.storage import VolumeBackfillJob, instant
    with database.begin() as db:
        for at in (0, 1740000):
            upsert(db, 'BTCUSDT', 'M1', Candle(instant(at), instant(at+60000), D(10), D(11), D(9), D(10)))
        volume_jobs.create(db, 'BTCUSDT', start=0, end=600000)
        second = volume_jobs.create(db, 'BTCUSDT', start=1200000, end=1800000)
        second.status, second.lease_token, second.lease_until = 'running', 'old', 9999999999999
        volume_jobs.create(db, 'BTCUSDT', start=300000, end=1500000)
        active = list(db.scalars(select(VolumeBackfillJob).where(VolumeBackfillJob.status != 'cancelled')))
        assert len(active) == 1 and active[0].start == 0 and active[0].end == 1800000
        assert second.lease_token is None and second.generation == 1
        import pytest
        with pytest.raises(ValueError, match='重叠'):
            volume_jobs.control(db, second.id, 'resume')


def test_retry_page_is_bounded_and_advances_failed_cursor(database):
    from alerts import volume_jobs
    from alerts.domain import Candle
    from alerts.market import upsert
    from alerts.storage import VolumeBackfillJob, VolumeBackfillSegment, instant
    with database.begin() as db:
        for at in (0, 86340000):
            upsert(db, 'BTCUSDT', 'M1', Candle(instant(at), instant(at+60000), D(10), D(11), D(9), D(10)))
        job = volume_jobs.create(db, 'BTCUSDT', start=0, end=86400000)
        ident = job.id
        db.add(VolumeBackfillSegment(job_id=ident, start=0, end=86400000, status='retry'))
    windows = []
    def fetched(source, symbol, start, end):
        from datetime import datetime
        left,right = int(datetime.fromisoformat(start).timestamp()*1000),int(datetime.fromisoformat(end).timestamp()*1000)
        windows.append((left,right))
        return dict(source=source, basis='last', rows=[])
    volume_jobs.once(fetched)
    assert windows == [(50400000,86400000)]
    with database.begin() as db:
        job = db.get(VolumeBackfillJob, ident)
        assert job.cursor == 50400000
        assert db.scalar(select(VolumeBackfillSegment.end).where(VolumeBackfillSegment.status=='retry')) == 50400000


def test_unpublishable_existing_price_bucket_is_partial_not_infinite_pending(database):
    from alerts import volume_jobs
    from alerts.domain import Candle
    from alerts.market import upsert
    from alerts.storage import ChartPublicationJob, instant
    with database.begin() as db:
        upsert(db, 'BTCUSDT', 'M1', Candle(instant(0), instant(60000), D(10), D(11), D(9), D(10), volume=D(2)))
        job = volume_jobs.create(db, 'BTCUSDT', start=0, end=60000)
        job.cursor = job.start
        db.add(ChartPublicationJob(instrument_id='BTCUSDT', timeframe='M30', start=0, end=1800000))
        db.flush()
        assert volume_jobs.finish(db,job)
        assert job.status == 'partial' and '价格桶不完整' in job.error


def test_volume_only_import_does_not_run_price_watch_evaluation(database, monkeypatch):
    from alerts import market
    from alerts.storage import ImportJob, Watch
    rows=[dict(timestamp=i*60000,open=10,high=11,low=9,close=10) for i in range(5)]
    with database.begin() as db:
        market.ingest(db,db.get(Instrument,'BTCUSDT'),{'rows':rows},received_at=305000)
        db.add(ImportJob(instrument_id='BTCUSDT',start=0,end=300000,cursor=0))
        db.add(Watch(instrument_id='BTCUSDT',name='price',rule={'kind':'price','timeframe':'M1','level':'11'},armed_at=0,status='active'))
    called=[]
    monkeypatch.setattr(market,'evaluate_watch',lambda *a:called.append(a))
    assert market.import_once(fetcher=lambda *a:dict(source='binance',basis='last',rows=[{**r,'volume':'2'} for r in rows]),defer_aggregation=True)
    assert called==[]


def test_volume_only_live_ingest_keeps_independent_tick_quotes(database, monkeypatch):
    from alerts import market
    from alerts.service import create_watch, evaluate_quote
    from alerts.storage import Watch

    rows = [dict(timestamp=i * 60000, open=10, high=11, low=9, close=10)
            for i in range(5)]
    with database.begin() as db:
        inst = db.get(Instrument, 'EURUSD')
        market.ingest(db, inst, {'rows': rows}, received_at=305000)
        evaluate_quote(db, inst, 305000, D('9'), D('9.1'))
        watch = create_watch(db, 'EURUSD', 'live tick',
                             {'kind': 'price', 'timeframe': 'tick', 'level': '10',
                              'direction': 'buy'}, armed_at=306000)
        watch_id = watch.id
    historical_evaluations = []
    calls = []
    monkeypatch.setattr(market, 'evaluate_watch',
                        lambda *args: historical_evaluations.append(args))

    def fetch(source, symbol, *args, **kwargs):
        calls.append(kwargs.get('mode', 'M1'))
        if kwargs.get('mode') == 'quote':
            return {'rows': [dict(timestamp=307000, bidPrice='11', askPrice='11.1')]}
        return {'rows': [{**row, 'volume': '2'} for row in rows]}

    market.once('EURUSD', fetcher=fetch)
    assert historical_evaluations == []
    assert calls == ['M1', 'quote']
    with database.begin() as db:
        assert db.get(Watch, watch_id).status == 'triggered'


def test_old_published_volume_revision_ignores_new_live_coverage_edges(database):
    from alerts.chart_data import chart_rows
    from alerts.domain import Candle
    from alerts.managed_dataset import publish_corrections
    from alerts.market import upsert
    from alerts.storage import ChartPublication, ChartPublicationJob, ChartPublishedBar, instant

    with database.begin() as db:
        inst = db.get(Instrument, 'BTCUSDT')
        row = upsert(db, inst.id, 'M1', Candle(instant(0), instant(60000),
                     D(10), D(11), D(9), D(10)))
        old = ChartPublishedBar(instrument_id=inst.id, timeframe='M1', start=0,
                                end=60000, complete=True,
                                payload=chart_rows(db, inst, 'M1', 60000, 1, 305000)[0])
        pub = ChartPublication(instrument_id=inst.id, timeframe='M1', start=0,
                               end=300000, complete_count=1)
        db.add_all([old, pub])
        db.flush()
        price = (row.open, row.high, row.low, row.close, row.complete,
                 row.revision, row.received_at)
        row.volume, row.volume_complete = D('2.12345678'), True
        db.add(ChartPublicationJob(instrument_id=inst.id, timeframe='M1', start=0, end=60000))
        db.flush()
        # Both current edges exclude this old confirmed snapshot. They cannot
        # downgrade its price completeness or prevent an independent quantity revision.
        publish_corrections(db, inst, pub, 'M1', 180000, 240000, [], 305000)
        assert old.payload['volume'] == '2.12345678' and old.payload['volume_complete']
        assert old.complete and old.payload['complete']
        assert (pub.start, pub.end, pub.complete_count) == (0, 300000, 1)
        assert (row.open, row.high, row.low, row.close, row.complete,
                row.revision, row.received_at) == price
        assert db.scalar(select(ChartPublicationJob.start)) is None


def test_unpublished_dirty_volume_outside_proven_range_is_partial(database):
    from alerts import volume_jobs
    from alerts.domain import Candle
    from alerts.market import upsert
    from alerts.storage import ChartPublication, ChartPublicationJob, instant

    with database.begin() as db:
        upsert(db, 'BTCUSDT', 'M1', Candle(instant(0), instant(60000),
               D(10), D(11), D(9), D(10), volume=D(2)))
        job = volume_jobs.create(db, 'BTCUSDT', start=0, end=60000)
        job.cursor = job.start
        db.add(ChartPublication(instrument_id='BTCUSDT', timeframe='M1',
                                start=180000, end=300000))
        db.add(ChartPublicationJob(instrument_id='BTCUSDT', timeframe='M1', start=0, end=60000))
        db.flush()
        assert volume_jobs.finish(db, job)
        assert job.status == 'partial' and '没有可更新发布快照' in job.error
        assert db.scalar(select(ChartPublicationJob.start)) == 0


def test_forming_published_quantity_revision_keeps_both_completeness_flags_false(database):
    from alerts.managed_dataset import join, publish_corrections, publish_frame
    from alerts.storage import ChartPublication, ChartPublicationJob, ChartPublishedBar

    rows = [dict(timestamp=i * 60000, open=10, high=11, low=9, close=10, volume='2')
            for i in range(12)]
    with database.begin() as db:
        inst = db.get(Instrument, 'BTCUSDT')
        plan = join(db, inst, 0, 725000)
        ingest(db, inst, {'rows': rows}, received_at=725000)
        publish_frame(db, inst, plan, 'M5', 725000)
        pub = db.get(ChartPublication, (inst.id, 'M5'))
        old = db.get(ChartPublishedBar, (inst.id, 'M5', 600000))
        assert old is not None and not old.complete
        staging = db.scalar(select(Bar).where(Bar.instrument_id == inst.id,
                            Bar.timeframe == 'M5', Bar.start == 600000))
        staging.volume = D(99)
        db.add(ChartPublicationJob(instrument_id=inst.id, timeframe='M5', start=600000, end=900000))
        db.flush()
        publish_corrections(db, inst, pub, 'M5', 0, 720000, [], 725000)
        assert old.payload['volume'] == '99'
        assert not old.complete and not old.payload['complete'] and not old.payload['volume_complete']
        assert db.scalar(select(ChartPublicationJob.start).where(
            ChartPublicationJob.timeframe == 'M5', ChartPublicationJob.start == 600000)) is None
