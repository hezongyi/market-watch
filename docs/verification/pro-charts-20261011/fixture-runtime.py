"""Ubuntu task-only supply fixture; real database/API/native engine remain intact.

Synthetic candles demonstrate application contracts, not supplier availability.
Never imported by application code or included in release images.
"""
import runpy
import sys
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from sqlalchemy.engine import make_url
from alerts.config import settings
from alerts import provider_chart, provider_transport
from alerts.storage import bootstrap, now_ms, transaction, MarketCatalog

url = make_url(settings.database_url)
assert url.host == "pg" and url.database == "pro_charts"
assert settings.database_application_name == "mw-pro-charts-20261011"
assert not settings.delivery_enabled
settings.oanda_account_id = "pro-charts-fixture"
settings.oanda_token = "fixture-no-provider-access"
settings.yahoo_enabled = True
settings.fx_source = "oanda"
BEGIN = int(datetime(2021, 1, 1, tzinfo=UTC).timestamp() * 1000)


def native_page(meta, frame, before, count, **kwargs):
    width = provider_chart.FRAME_MS[frame]
    limit = (now_ms() - 5000) // 60000 * 60000
    right = min(before, limit)
    latest = BEGIN + (right - 1 - BEGIN) // width * width
    starts = list(range(max(BEGIN, latest - (count - 1) * width), latest + 1, width))
    if frame == "MN":
        last = datetime.fromtimestamp((right - 1) / 1000, UTC).replace(day=1,hour=0,minute=0,second=0,microsecond=0)
        starts=[]
        while len(starts)<count and int(last.timestamp()*1000)>=BEGIN:
            starts.append(int(last.timestamp()*1000));last=(last-timedelta(days=1)).replace(day=1)
        starts.reverse()
    base = Decimal('1.12') if 'EUR' in meta['symbol'] else Decimal('4000') if 'XAU' in meta['symbol'] else Decimal('250') if meta['source']=='yahoo' else Decimal('65000')
    unit = Decimal(1).scaleb(-meta['precision'])
    bars=[]
    from alerts.provider_dukascopy import interval_end
    for start in starts:
        end=interval_end(start,frame);price=base+unit*(start//60000%7)
        bars.append({'start':start,'end':end,'chart_time':provider_chart.label(start,frame,meta['calendar']),
            'open':str(price),'high':str(price+unit*2),'low':str(price-unit*2),'close':str(price+unit),
            'volume':'100','volume_complete':True,'complete':end<=limit})
    boundary=not bars or bars[0]['start']<=BEGIN
    from alerts.volume import metadata as volume
    return {'bars':bars,'history_boundary':boundary,'has_more':not boundary,
        'coverage':[[bars[0]['start'] if bars else 0,before]],'as_of':now_ms(),
        'series_kind':'provider','basis':meta['basis'],'calendar':meta['calendar'],
        'precision':meta['precision'],'indicators':[],**volume(meta['source'],meta['symbol'])}

provider_chart.native_page=native_page
provider_chart.warm_clients=lambda:None
provider_transport.warm_connections=lambda *args:None
bootstrap()
from alerts import yahoo_catalog
from alerts import provider_yahoo
# Controlled supplier discovery prevents external network and cached metadata expiry.
provider_yahoo.search_metadata=lambda *args,**kwargs:[]
provider_yahoo.metadata=lambda *args,**kwargs:_metadata({'symbol':'AAPL','quoteType':'EQUITY','exchangeTimezoneName':'America/New_York',
    'exchange':'NMS','currency':'USD','priceHint':2,'regularMarketPrice':250,'longName':'Apple synthetic acceptance',
    'firstTradeDateMilliseconds':BEGIN})
from alerts.provider_yahoo import stable_id
from alerts.history_catalog import account_scope
with transaction() as db:
    from alerts.storage import Instrument
    if not db.get(Instrument,'USDJPY'):
        db.add(Instrument(id='USDJPY',label='USDJPY synthetic acceptance',source='oanda',symbol='USD_JPY',basis='bid',calendar='ny17',precision=3))
    ident=stable_id('AAPL')
    from alerts.provider_yahoo import _metadata
    details=_metadata({'symbol':'AAPL','quoteType':'EQUITY','exchangeTimezoneName':'America/New_York',
        'exchange':'NMS','currency':'USD','priceHint':2,'regularMarketPrice':250,'longName':'Apple synthetic acceptance',
        'firstTradeDateMilliseconds':BEGIN})
    row=db.get(MarketCatalog,ident)
    if row is None:
        row=MarketCatalog(id=ident,source='yahoo',symbol='AAPL');db.add(row)
    row.label='Apple synthetic acceptance';row.asset_type='EQUITY';row.precision=8;row.calendar='yahoo'
    row.updated_at=now_ms();row.metadata_json=details
    ident='HC:'+'a'*36
    if not db.get(MarketCatalog,ident):
        db.add(MarketCatalog(id=ident,source='oanda',symbol='EUR_USD',label='EURUSD synthetic target',
            asset_type='CURRENCY',precision=5,calendar='ny17',metadata_json={'history_account_scope':account_scope()}))
mode=sys.argv[1]
if mode=='api':
    import uvicorn
    uvicorn.run('alerts.api:app',host='0.0.0.0',port=8000)
elif mode=='native':runpy.run_module('alerts.native_history_loads',run_name='__main__')
elif mode=='market':runpy.run_module('alerts.market_stream_worker',run_name='__main__')
elif mode=='prepare':
    import uuid
    from alerts.market_contracts import DatasetIdentity, MinuteRow, CandleBatch, RequestResult
    from alerts.composite_preparation import preparation_tick
    from alerts.composite_aggregates import aggregate_tick
    from alerts.composite_revisions import preparation_tick as revision_tick
    from alerts.storage import CompositePreparation
    revision=str(uuid.UUID(sys.argv[2]))
    class Adapter:
        def page(self,identity,left,right):
            rows=tuple(MinuteRow(timestamp=at,open='1.12000',high='1.12100',low='1.11900',close='1.12001',volume='1',complete=True) for at in range(left,right,60000))
            return CandleBatch(identity=identity,window_start=left,window_end=right,observed_at=now_ms(),result=RequestResult(status='data'),rows=rows,checkpoint=right,volume_kind='price_count',volume_unit='quotes')
        def close(self):pass
    with transaction() as db:
        prep=db.get(CompositePreparation,revision)
        assert prep is not None
        prep.next_at=0
    for turn in range(100):
        if not preparation_tick(Adapter(),revision):break
    else:raise AssertionError('Preparation did not converge')
    for turn in range(1000):
        if not aggregate_tick(revision):break
    else:raise AssertionError('Aggregate did not converge')
    revision_tick()
    print('Isolated synthetic preparation completed for '+revision)
else:raise ValueError('Unknown fixture mode')
