"""Full-contract pandas/Polars prototypes, not a shipped aggregation path.

Exact Decimal integers for OHLC/quantity, real calendar bucket keys and existing
coverage finalization; every output field compared over gaps/DST/null/partials.
"""
import json,time,resource
from itertools import product
from datetime import datetime,UTC
from decimal import Decimal
from types import SimpleNamespace
from pathlib import Path
import pandas as pd
import polars as pl
from alerts.history_artifacts import _pair,_add,_finish
from alerts.market_datasets import version_price_rows,PRICE_RULE_VERSION
from alerts.domain import scheduled_open,calendar_for

frames=['M1','M5','M15','M30','H1','H4','D1','W1','MN']
report={'scope':'CPU prototypes; bounded 60,000-minute inputs, NY17/UTC0, full output contract, synthetic gaps/DST/null quantity/partial confirmations; no end-to-end speed claim','cases':[],'pandas':pd.__version__,'polars':pl.__version__,'input_minutes_per_case':60000,'price_decimal_places':5,'quantity_decimal_places':2}
for calendar,date in product(['ny17','utc0'],['2026-02-20','2026-10-25']):
 start=int(datetime.fromisoformat(date).replace(tzinfo=UTC).timestamp()*1000);n=60000
 inst=SimpleNamespace(id='MD:synthetic:EURUSD',calendar=calendar,calendar_profile={})
 version=SimpleNamespace(id='synthetic',start=start,end=start+n*60000)
 dataset=SimpleNamespace(volume_kind='quantity',volume_unit='source_quantity')
 raw=[]
 for i in range(n):
  if i%197 in (0,1):continue
  price=Decimal(112000+i%101)/100000
  raw.append({'timestamp':start+i*60000,'open':str(price),'high':str(price+Decimal('.00011')),'low':str(price-Decimal('.00007')),'close':str(price+Decimal('.00002')),'volume':None if i%131==0 else '1.25','complete':i%193!=0})
 begin=time.perf_counter();rows=version_price_rows(raw,{'price_rule_version':PRICE_RULE_VERSION,'price_precision':5});decode=time.perf_counter()-begin
 for frame in frames:
  begin=time.perf_counter();expected=[];state={};keys=[]
  for row in rows:
   left,right=_pair(row['timestamp'],frame,inst);keys.append((left,right))
   if state and state['start']!=left:expected.append(_finish(state,inst,version,dataset));state={}
   if not state:state={'start':left,'end':right}
   _add(state,row,inst)
  if state:expected.append(_finish(state,inst,version,dataset))
  baseline=time.perf_counter()-begin
  begin=time.perf_counter();units={'bucket':[p[0] for p in keys],'end':[p[1] for p in keys],
    **{k:[int(Decimal(r[k])*100000) for r in rows] for k in ['open','high','low','close']},
    'volume':[int(Decimal(r['volume'])*100) if r['volume'] is not None else 0 for r in rows],
    'volume_present':[r['volume'] is not None for r in rows],
    'source_confirmed':[r['complete'] for r in rows],
    'conflict':[not scheduled_open(datetime.fromtimestamp(r['timestamp']/1000,UTC),calendar_for(inst)) for r in rows],
    'observed':[1]*len(rows)}
  # Explicitly prove Int64 range and exact scaling for this prototype corpus.
  # Quantity uses its own scale; neither float rounding nor price scale is used.
  for key in ['open','high','low','close']:
   assert all(-(2**63)<=v<2**63 and Decimal(v)/100000==Decimal(row[key]) for v,row in zip(units[key],rows))
  assert all(Decimal(v)/100==Decimal(row['volume']) for v,row in zip(units['volume'],rows) if row['volume'] is not None)
  assert sum(abs(v) for v in units['volume'])<2**63
  conversion=time.perf_counter()-begin
  speeds={}
  for engine in ['pandas','polars']:
   begin=time.perf_counter()
   if engine=='pandas':
    grouped=pd.DataFrame(units).groupby('bucket',sort=False).agg(end=('end','last'),open=('open','first'),high=('high','max'),low=('low','min'),close=('close','last'),volume=('volume','sum'),volume_present=('volume_present','all'),source_confirmed=('source_confirmed','all'),conflict=('conflict','any'),observed=('observed','sum')).reset_index().to_dict('records')
   else:
    grouped=pl.DataFrame(units).group_by('bucket',maintain_order=True).agg(pl.col('end').last(),pl.col('open').first(),pl.col('high').max(),pl.col('low').min(),pl.col('close').last(),pl.col('volume').sum(),pl.col('volume_present').all(),pl.col('source_confirmed').all(),pl.col('conflict').any(),pl.col('observed').sum()).to_dicts()
   output=[]
   for row in grouped:
    state={**row,'start':row['bucket'],**{k:str(Decimal(row[k])/100000) for k in ['open','high','low','close']},'volume':str(Decimal(row['volume'])/100)}
    output.append(_finish(state,inst,version,dataset))
   for got,want in zip(output,expected):
    # Equivalent decimal representation; all semantic fields must match.
    for key in ['open','high','low','close','volume']:
     if got[key] is not None:got[key]=str(Decimal(got[key]).normalize());want[key]=str(Decimal(want[key]).normalize())
   assert output==expected,(calendar,date,frame,engine)
   speeds[engine]=time.perf_counter()-begin
  report['cases'].append({'calendar':calendar,'date':date,'frame':frame,'observations':len(rows),'bars':len(expected),'baseline_seconds':baseline,'normalization_seconds':decode,'integer_calendar_conversion_seconds':conversion,'group_and_complete_seconds':speeds,'exact_integer_scaling_and_int64_range':True,'all_fields_equal':True})
  print(json.dumps({'calendar':calendar,'date':date,'frame':frame,'passed':True}),flush=True)
report['passed']=True;report['peak_rss_kib']=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
Path(__file__).with_suffix('.json').write_text(json.dumps(report,indent=2));print(json.dumps(report),flush=True)
