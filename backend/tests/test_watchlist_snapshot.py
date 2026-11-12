"""Mixed watchlist startup reads committed data, never a slow supplier."""
from decimal import Decimal

import pytest
from alerts import provider_chart
from alerts.market_data import QuoteQuery, quote_snapshot
from alerts.provider_cache import identity
from alerts.storage import MarketStreamTask, now_ms
from test_provider_cache import META


def test_mixed_snapshot_never_opens_upstream_and_keeps_real_observation(database, monkeypatch):
    meta = {**META, 'name':'Test', 'display_symbol':'TEST'}
    monkeypatch.setattr(provider_chart, 'metadata', lambda *a, **kw: meta)
    monkeypatch.setattr(provider_chart, 'quote_page', lambda *a, **kw: pytest.fail('snapshot cannot call supplier'))
    monkeypatch.setattr(provider_chart, 'quote_previous_close', lambda *a, **kw: pytest.fail('snapshot cannot query previous close'))
    stamp = now_ms()
    with database.begin() as db:
        db.add(MarketStreamTask(id='a'*64,identity={'kind':'quotes','series_kind':'provider',
            'dataset_id':identity(meta,'M1')},query={},payload={'type':'quotes','quotes':[
            {'s':'ok','n':'other-alias','v':{'lp':1.123,'read_at':stamp,'data_start':stamp-30000,
             'data_end':stamp+30000,'time_type':'source_m1','fetch_status':'ok'}}]},
            updated_at=stamp,expires=stamp+120000))
    rows = quote_snapshot(QuoteQuery(symbols=['MWP:'+META['id'],'BTCUSDT'],snapshot_only=True))
    assert rows[0]['v']['lp'] == 1.123
    assert rows[0]['n'] == 'MWP:'+META['id']
    assert rows[0]['v']['read_at'] == stamp
    assert len(rows)==2


def test_empty_local_snapshot_is_pending_without_inventing_a_price(database, monkeypatch):
    monkeypatch.setattr(provider_chart,'metadata',lambda *a,**kw:{**META,'name':'Test'})
    monkeypatch.setattr(provider_chart,'quote_page',lambda *a,**kw:pytest.fail('cold snapshot cannot fetch'))
    value=quote_snapshot(QuoteQuery(symbols=['MWP:'+META['id']],snapshot_only=True))[0]['v']
    assert value['fetch_status']=='pending'
    assert 'lp' not in value and value.get('quote_time') is None


def test_snapshot_never_reuses_another_account_or_price_basis(database, monkeypatch):
    meta={**META,'name':'Test'}
    monkeypatch.setattr(provider_chart,'metadata',lambda *a,**kw:meta)
    with database.begin() as db:
        db.add(MarketStreamTask(id='a'*64,identity={'kind':'quotes','series_kind':'provider',
            'dataset_id':identity({**meta,'basis':'ask'},'M1')},query={},payload={'type':'quotes',
            'quotes':[{'s':'ok','v':{'lp':9}}]},updated_at=now_ms(),expires=now_ms()+120000))
    value=quote_snapshot(QuoteQuery(symbols=['MWP:'+META['id']],snapshot_only=True))[0]['v']
    assert 'lp' not in value


def test_previous_close_is_nonblocking_shared_and_bounded(database, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from decimal import Decimal
    from threading import Event

    from alerts.provider_quote_reads import PreviousCloses
    entered, release = Event(), Event()
    calls=[]
    def slow(meta, latest):
        calls.append(meta['id'])
        entered.set()
        assert release.wait(2)
        return Decimal('1.1')
    monkeypatch.setattr(provider_chart,'quote_previous_close',slow)
    latest={'start':now_ms()}
    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            cache=PreviousCloses(executor)
            assert cache.read(META,latest) is None
            assert entered.wait(1)
            assert cache.read(META,latest) is None
            assert cache.read({**META,'id':'another-alias'},latest) is None
            assert cache.read({**META,'id':'another-symbol','symbol':'GBP_USD'},latest) is None
            assert calls==[META['id']], 'same source cannot queue more previous-close IO'
            release.set()
            list(cache.entries.values())[0]['future'].result(timeout=1)
            assert cache.read(META,latest)==Decimal('1.1')
            assert cache.read({**META,'id':'another-alias'},latest)==Decimal('1.1')
    finally:
        release.set()


def test_shared_worker_returns_last_price_without_waiting_for_previous_close(database, monkeypatch):
    from alerts.chart_query import DataQuery
    from alerts.market_stream_worker import Calculator
    meta={**META,'name':'Test'}
    monkeypatch.setattr(provider_chart,'metadata',lambda *a,**kw:meta)
    from alerts import provider_quote_reads
    monkeypatch.setattr(provider_quote_reads,'page',lambda *_:{'bars':[{'start':60000,'end':120000,'close':'1.2'}]})
    monkeypatch.setattr(provider_chart,'quote_previous_close',lambda *_:pytest.fail('worker cannot block on previous-close IO'))
    payload,_=Calculator().build({'id':'b'*64,'query':DataQuery(instrument=META['id'],series_kind='provider',timeframe='M1').model_dump(),
        'identity':{'kind':'quotes','metadata':meta,'dataset_id':identity(meta,'M1')}})
    assert payload['quotes'][0]['v']['lp']==1.2
    assert 'ch' not in payload['quotes'][0]['v']


def test_local_work_can_be_claimed_while_provider_quotes_are_busy(database, monkeypatch):
    from alerts import market_stream as stream
    from alerts.chart_query import DataQuery
    from alerts.market_stream_api import Subscription, resolve
    from test_market_stream import session
    meta={**META,'name':'Test'}
    monkeypatch.setattr(provider_chart,'metadata',lambda *a,**kw:meta)
    owner=session(database)
    for ticker,kind,listener in ((META['id'],'provider','slow'),('BTCUSDT','managed','local')):
        ident,query=resolve(Subscription(client='page',listener=listener,generation=1,
            kind='quotes',query=DataQuery(instrument=ticker,series_kind=kind,timeframe='M1')))
        stream.register(owner,'page',listener,1,ident,query,{})
    work=stream.claim(allow_provider_quotes=False)
    assert work['identity']['instrument']=='BTCUSDT'
    assert stream.claim(exclude=[work['id']],allow_provider_quotes=False) is None
    assert stream.claim(exclude=[work['id']])['identity']['instrument']==META['id']


def test_stale_committed_snapshot_preserves_observation_time(database, monkeypatch):
    meta={**META,'name':'Test'}
    monkeypatch.setattr(provider_chart,'metadata',lambda *a,**kw:meta)
    old=now_ms()-600000
    with database.begin() as db:
        db.add(MarketStreamTask(id='a'*64,identity={'kind':'quotes','series_kind':'provider',
            'dataset_id':identity(meta,'M1')},query={},payload={'type':'quotes','quotes':[
            {'s':'ok','v':{'lp':1.1,'read_at':old,'fetch_status':'ok'}}]},updated_at=old,expires=old))
    value=quote_snapshot(QuoteQuery(symbols=['MWP:'+META['id']],snapshot_only=True))[0]['v']
    assert value['lp']==1.1 and value['fetch_status']=='stale'
    assert value['read_at']==old


def test_platform_quote_persists_one_candle_and_alias_reuses_it(database, monkeypatch):
    from alerts import provider_cache as cache
    from alerts import provider_quote_reads as reads
    from alerts.config import settings
    calls=[]
    meta={**META,'name':'Test'}
    monkeypatch.setattr(settings,'oanda_acquisition_mode','stream')
    stamp=now_ms()//60000*60000+30000
    monkeypatch.setattr(reads,'now_ms',lambda:stamp)
    monkeypatch.setattr(cache,'now_ms',lambda:stamp)
    def fetch(meta,frame,before,count,**kwargs):
        calls.append((frame,count))
        return {'bars':[{'start':stamp//60000*60000,'end':stamp//60000*60000+60000,
            'chart_time':stamp//60000*60000,'open':'1','high':'2','low':'0','close':'1.2','complete':False}],
            'history_boundary':False}
    monkeypatch.setattr(provider_chart,'native_page',fetch)
    first=reads.page(meta)
    second=reads.page({**meta,'id':'alias'})
    assert first['bars']==second['bars'] and calls==[('M1',1)]
    monkeypatch.setattr(provider_chart,'metadata',lambda *a,**kw:meta)
    value=quote_snapshot(QuoteQuery(symbols=['MWP:'+META['id']],snapshot_only=True))[0]['v']
    assert value['lp']==1.2 and value['data_start']==stamp//60000*60000
    assert value['quote_time'] is None and value['time_type']=='source_m1'


def seed_previous_close(meta, latest):
    from alerts.provider_chart import previous_close_query
    from test_provider_cache import seed
    before, _, boundary = previous_close_query(meta, latest)
    seed(meta, 'D1', before, {'bars':[
        {'start':boundary-days*86400000, 'end':boundary-(days-1)*86400000,
         'chart_time':before-days*86400000, 'open':'1', 'high':'2', 'low':'0',
         'close':'1.1', 'complete':True} for days in (2, 1)], 'history_boundary':False})


@pytest.mark.parametrize('committed', [False, True])
def test_reopened_watchlist_keeps_changes_from_persisted_daily_close(database, monkeypatch, committed):
    from alerts import provider_quote_reads as reads
    from test_provider_cache import seed
    stamp = now_ms() // 60000 * 60000
    meta = {**META, 'name':'Test'}
    latest = {'start':stamp, 'end':stamp+60000, 'chart_time':stamp,
              'open':'1', 'high':'2', 'low':'0', 'close':'1.2', 'complete':False}
    seed(meta, 'M1', stamp+1, {'bars':[latest], 'history_boundary':False}, latest=True)
    seed_previous_close(meta, latest)
    if committed:
        with database.begin() as db:
            db.add(MarketStreamTask(id='a'*64, identity={'kind':'quotes', 'series_kind':'provider',
                'dataset_id':identity(meta,'M1')}, query={}, payload={'type':'quotes', 'quotes':[
                    {'s':'ok', 'v':{'lp':1.2, 'data_start':stamp, 'read_at':stamp}}]},
                updated_at=stamp, expires=stamp+120000))
    monkeypatch.setattr(provider_chart, 'metadata', lambda *a, **kw: meta)
    monkeypatch.setattr(provider_chart, 'native_page', lambda *a, **kw: pytest.fail('snapshot must stay local'))
    values = quote_snapshot(QuoteQuery(symbols=['MWP:'+META['id']], snapshot_only=True))[0]['v']
    assert values['prev_close_price'] == 1.1
    assert values['ch'] == pytest.approx(.1)
    assert values['chp'] == pytest.approx(.1/1.1*100)
    assert reads.PreviousCloses().read(meta, latest) == Decimal('1.1')
    # A new session cannot reuse yesterday's reference when its closing bar
    # has not been observed. Another price basis cannot borrow it either.
    assert reads.PreviousCloses().read(meta, {**latest, 'start':stamp+86400000}) is None
    assert reads.PreviousCloses().read({**meta, 'basis':'ask'}, latest) is None


def test_stale_latest_price_still_recalculates_changes_without_supplier_io(database, monkeypatch):
    stamp = now_ms() // 60000 * 60000
    meta = {**META, 'name':'Test'}
    latest = {'start':stamp, 'end':stamp+60000, 'close':'1.2'}
    seed_previous_close(meta, latest)
    monkeypatch.setattr(provider_chart, 'metadata', lambda *a, **kw: meta)
    monkeypatch.setattr(provider_chart, 'quote_previous_close', lambda *_: pytest.fail('stale cannot open daily IO'))
    rows = quote_snapshot(QuoteQuery(symbols=['MWP:'+META['id']]), provider_page=lambda *_:{
        'bars':[latest], 'fetch_status':'stale'})
    values = rows[0]['v']
    assert values['fetch_status'] == 'stale'
    assert values['prev_close_price'] == 1.1
    assert values['ch'] == pytest.approx(.1)


def test_background_previous_close_survives_new_calculator(database, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from decimal import Decimal

    from alerts.provider_quote_reads import PreviousCloses
    latest = {'start':now_ms() // 60000 * 60000}
    before, _, boundary = provider_chart.previous_close_query(META, latest)
    calls = []
    def fetch(meta, frame, cutoff, count, **kw):
        calls.append((frame, cutoff, count))
        return {'bars':[
            {'start':boundary-days*86400000, 'end':boundary-(days-1)*86400000,
             'chart_time':before-days*86400000, 'open':'1', 'high':'2', 'low':'0',
             'close':'1.1', 'complete':True} for days in (2, 1)], 'history_boundary':False}
    monkeypatch.setattr(provider_chart, 'native_page', fetch)
    with ThreadPoolExecutor(max_workers=2) as executor:
        closes = PreviousCloses(executor)
        assert closes.read(META, latest) is None
        list(closes.entries.values())[0]['future'].result(timeout=2)
    assert PreviousCloses().read(META, latest) == Decimal('1.1')
    assert len(calls) == 1


def test_previous_close_refreshes_an_old_daily_tail_even_if_recently_observed(database, monkeypatch):
    latest = {'start':now_ms() // 60000 * 60000}
    seed_previous_close(META, {'start':latest['start']-2*86400000})
    before, _, boundary = provider_chart.previous_close_query(META, latest)
    calls = []
    def fetch(meta, frame, cutoff, count, **kw):
        calls.append((frame, cutoff, count))
        return {'bars':[
            {'start':boundary-days*86400000, 'end':boundary-(days-1)*86400000,
             'chart_time':before-days*86400000, 'open':'1', 'high':'2', 'low':'0',
             'close':'1.5', 'complete':True} for days in (2, 1)], 'history_boundary':False}
    monkeypatch.setattr(provider_chart, 'native_page', fetch)
    assert provider_chart.quote_previous_close(META, latest) == Decimal('1.5')
    assert calls == [('D1', before, 2)]
