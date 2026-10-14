"""Controlled supplier in the task's isolated PostgreSQL schema; no external IO."""
import json,threading,time,atexit
from pathlib import Path
from argon2 import PasswordHasher
from sqlalchemy import text, select, func
from alerts import storage,provider_cache as cache,provider_chart,provider_service,provider_transport,market_stream_worker as worker
from alerts.config import settings
schema='native_reset_browser'
# A task-owned schema, separate from tests and every other project.
with storage.Session.begin() as db:db.execute(text('CREATE SCHEMA IF NOT EXISTS '+schema))
settings.database_url=settings.database_url+'?options=-csearch_path%3D'+schema
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
storage.engine=create_engine(settings.database_url)
storage.Session=sessionmaker(storage.engine,expire_on_commit=False)
clock=[storage.now_ms()]
cache.now_ms=lambda:clock[0]
worker.now_ms=lambda:clock[0]
meta={'id':'EURUSD','symbol':'EURUSD','source':'oanda','basis':'bid','calendar':'ny17','precision':5,'name':'Controlled EURUSD'}
provider_chart.metadata=lambda *a,**k:meta
provider_chart.warm_clients=lambda:None
provider_service.start=lambda:None
provider_service.stop=lambda:None
provider_transport.start=lambda _:None
from alerts import api
from alerts.storage import AdvancedWorkspace,Preference
storage.bootstrap(storage.engine)
api.bootstrap=lambda:None
settings.admin_password_hash=PasswordHasher().hash(json.loads(Path('/private/credentials.private.json').read_text())['password'])
with storage.transaction() as db:
 if not db.get(AdvancedWorkspace,'native-reset-acceptance'):
  db.add(AdvancedWorkspace(id='native-reset-acceptance',name='主 SSE reset 隔离验收',document={'engine':'tv31','symbol':'MWP:EURUSD','interval':'1'},revision=1))
  db.flush()
 db.get(Preference,'auth.admin').value={'hash':settings.admin_password_hash}
with storage.transaction() as db:
 existing_key=cache.ensure(meta,'M1')
 previous_tail=db.scalar(select(func.max(storage.ProviderBar.start)).where(storage.ProviderBar.dataset_id==existing_key))
row_start=max(clock[0]//60000*60000,previous_tail or 0)
clock[0]=max(clock[0],row_start+5000)
rows=[dict(start=row_start-i*60000,end=row_start-(i-1)*60000,chart_time=row_start-i*60000,open='1.1',high='1.12',low='1.09',close='1.11',volume='5',complete=i>0) for i in reversed(range(800))]
def seed(bars,before):
 key=cache.ensure(meta,'M1');lease=cache.claim(key)
 cache.commit_page(key,lease,{'bars':bars,'history_boundary':True},before,clock[0],latest=True);cache.release(key,lease)
 return key
key=seed(rows,row_start+60000)
lock=threading.Lock();stop=threading.Event();calculator=worker.Calculator()
def loop():
 while not stop.wait(.1):
  with lock:
   try:worker.tick(calculator)
   except Exception as e:print('fixture worker',type(e).__name__,flush=True)
thread=threading.Thread(target=loop,daemon=True);thread.start();atexit.register(stop.set)
app=api.app
from fastapi import Depends
@app.post('/api/reset-fixture/control',dependencies=[Depends(api.authenticated)])
def control(body:dict):
 global rows
 with lock:
  clock[0]+=1000
  if body['op']=='handoff':
   old=rows[-1];confirmed={**old,'complete':True,'volume_complete':True}
   if body.get('change')=='price':confirmed['close']='1.115'
   if body.get('change')=='volume':confirmed['volume']='6'
   tail={**old,'start':old['end'],'chart_time':old['end'],'end':old['end']+60000,'complete':False,'close':'1.11'}
   clock[0]=max(clock[0],tail['start']+5000)
   rows[-1]=confirmed;rows.append(tail);seed([confirmed,tail],tail['end'])
  elif body['op']=='tail':
   rows[-1]={**rows[-1],'close':'1.112' if rows[-1]['close']!='1.112' else '1.113'};seed([rows[-1]],rows[-1]['end'])
  elif body['op']=='repair':
   pos=-2 if body.get('target')=='previous' else -20
   rows[pos]={**rows[pos],body.get('field','close'):body.get('value','1.118')};seed([rows[pos]],rows[pos]['end'])
  return {'ok':True,'last':rows[-1]['start']}
