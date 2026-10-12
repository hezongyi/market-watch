"""Task-isolated PostgreSQL derivation benchmark, synthetic realistic shape.

A published fixed input is built from verified immutable chunks. The timer spans
all nine actual artifact ticks including PG reads/commits, checksums, calendar,
coverage, Decimal, encoding and publication. Supplier import is measured separately.
The ephemeral schema belongs to this invocation and is removed on completion.
"""
import gzip, hashlib, json, os, resource, time, uuid
from datetime import datetime, UTC
from decimal import Decimal
from pathlib import Path
from sqlalchemy import create_engine, text, select
from sqlalchemy.orm import sessionmaker
from alerts import storage, history_artifacts as a, history_versions as h
from alerts.market_contracts import DatasetIdentity
from alerts.market_datasets import register_dataset
from alerts.chart_data import FRAMES

url=os.environ['TEST_POSTGRES_URL'];assert ':19995/' in url and url.endswith('/pro_charts')
admin=create_engine(url);schema='pro_charts_perf_'+uuid.uuid4().hex
with admin.begin() as db:db.execute(text(f'CREATE SCHEMA {schema}'))
engine=create_engine(url,connect_args={'options':f'-csearch_path={schema}'},pool_size=2,max_overflow=0)
storage.Base.metadata.create_all(engine);factory=sessionmaker(engine,expire_on_commit=False);storage.Session=factory
rows_target=int(os.getenv('DERIVE_ROWS','2147763'));start=int(datetime(2019,1,1,tzinfo=UTC).timestamp()*1000)
ident=DatasetIdentity(source='dukascopy',channel='python',environment='historical',account_scope='public',provider_symbol='EUR/USD',basis='bid',calendar_version='synthetic-perf-v1')
report={'scope':'Ubuntu isolated PostgreSQL, synthetic observed M1, actual nine-period derivation; no supplier import speed claim','rows':rows_target,'frames':FRAMES,'phases':{},'ticks':0,'decode_calls':0}
timers={'input':0.,'finish':0.,'encode':0.,'compressed':0.}
original_input,original_finish=a._page_input,a._finish
# Avoid profiler overhead inside per-row aggregation; instrument chunk and bucket boundaries.
def timed_input(*args):
    before=time.perf_counter();value=original_input(*args);timers['input']+=time.perf_counter()-before;return value
def timed_finish(*args):
    before=time.perf_counter();value=original_finish(*args);timers['finish']+=time.perf_counter()-before;return value
a._page_input,a._finish=timed_input,timed_finish
original_normalize=a.version_price_rows
def normalize(*args):report['decode_calls']+=1;return original_normalize(*args)
a.version_price_rows=normalize
out=Path(__file__).with_name('derive-end-to-end.json')
try:
    begin=time.perf_counter()
    with factory.begin() as db:
        inst=register_dataset(db,ident,logical_symbol='EURUSD',label='Synthetic performance fixture',calendar='ny17',precision=5,volume_kind='quantity',volume_unit='source_quantity')
        # Final bound is assigned before this new version's first commit.
        v=storage.HistoryVersion(dataset_id=ident.key,start=start,end=start+60000,cursor=start,manifest={'price_rule_version':'dataset-precision-half-up-v1','price_precision':5})
        db.add(v);db.flush();vid=v.id
        cursor=start;observed=0;chunk_no=0
        while observed<rows_target:
            left=cursor;rows=[]
            while len(rows)<44000 and observed<rows_target:
                minute_index=(cursor-start)//60000
                # Weekends, unknown gaps, missing volume and supplier partials.
                weekday=(1+minute_index//1440)%7
                if weekday<5 and minute_index%997 not in (0,1,2):
                    value=Decimal(112000+minute_index%101)/100000
                    rows.append({'timestamp':cursor,'open':str(value),'high':str(value+Decimal('.00011')),'low':str(value-Decimal('.00007')),'close':str(value+Decimal('.00002')),'volume':None if minute_index%137==0 else '1.25','complete':minute_index%211!=0})
                    observed+=1
                cursor+=60000
            raw=json.dumps(rows,sort_keys=True,separators=(',',':')).encode()
            db.add(storage.HistoryChunk(version_id=vid,start=left,end=cursor,observed_at=cursor+5000,count=len(rows),checksum=hashlib.sha256(raw).hexdigest(),content=gzip.compress(raw,mtime=0),result='data',unknown=[]))
            chunk_no+=1
        v.end=cursor;v.cursor=cursor;db.flush();h.publish(db,v)
        a.request_artifacts(db,v,FRAMES)
    report['phases']['fixture_publish_seconds']=time.perf_counter()-begin
    begin=time.perf_counter();longest=0
    while True:
        before=time.perf_counter();worked=a.artifact_tick(vid);duration=time.perf_counter()-before
        if not worked:break
        report['ticks']+=1;longest=max(longest,duration)
        if report['ticks']%100==0:print(json.dumps({'ticks':report['ticks'],'seconds':time.perf_counter()-begin,'cache_bytes':a._input_bytes}),flush=True)
    report['phases']['nine_period_end_to_end_seconds']=time.perf_counter()-begin
    report['phases']['input_read_validate_decode_calendar_seconds']=timers['input']
    report['phases']['bucket_coverage_finalize_seconds']=timers['finish']
    report['longest_tick_seconds']=longest;report['cache_bytes']=a._input_bytes
    report['peak_rss_kib']=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    with factory() as db:
        periods=a.artifact_report(db,vid);assert len(periods)==9 and all(p['status']=='published' for p in periods)
        report['periods']=[{k:p[k] for k in ('timeframe','status','rows','complete_rows')} for p in periods]
        report['progress']=a.derivation_progress(db,db.get(storage.HistoryVersion,vid))
        assert report['progress']['processed_rows']==rows_target*9
        assert report['progress']['total_rows']==rows_target*9
    report['passed']=True;out.write_text(json.dumps(report,indent=2));print(json.dumps(report),flush=True)
finally:
    engine.dispose()
    with admin.begin() as db:db.execute(text(f'DROP SCHEMA {schema} CASCADE'))
    admin.dispose()
