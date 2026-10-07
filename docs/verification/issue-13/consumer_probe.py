"""Authenticated API routing and alert evaluation microbaseline in own PG only.

Run after the serial suite; no upstream/background lifespan, server, browser or
delivery. This does not replace full API/browser/concurrent acceptance.
"""
import asyncio
import hashlib
import json
import secrets
import time
from collections import Counter

import httpx
from sqlalchemy import event

from pg_baseline import IDENTITIES, NOW, ROOT, START, reset, s, write_json
from alerts.api import app
from alerts.chart_alert_service import AlertConfig, create
from alerts.chart_alert_worker import evaluate
from alerts.managed_dataset import read_rows
from alerts import managed_dataset as managed


def stats(values):
    values=sorted(values)
    return dict(count=len(values),p50=values[int((len(values)-1)*.5)],
        p95=values[int((len(values)-1)*.95)],p99=values[int((len(values)-1)*.99)],maximum=max(values)) if values else dict(count=0)


async def main():
    if 'SUITE COMPLETE' not in (ROOT/'suite.log').read_text():
        raise SystemExit('Wait for the existing full suite before resetting fixture')
    target=ROOT/'consumer-microbaseline.json'
    if target.exists():
        raise SystemExit('Existing consumer evidence retained; archive deliberately before rerun')
    reset()
    # The initial 2000-minute publication has no W1/MN; expand explicitly for
    # a meaningful four-period consumer microbaseline, preserving the empty
    # window's first run separately as waiting-state evidence.
    with s.transaction() as db:
        for ident in IDENTITIES:
            managed.join(db,db.get(s.Instrument,ident),START,NOW)
    for ident in IDENTITIES:
        for frame in ('M1','M30','W1','MN'):
            with s.transaction() as db:
                inst=db.get(s.Instrument,ident)
                managed.publish_frame(db,inst,db.get(s.ChartHistoryPlan,ident),frame,NOW)
    token,csrf=secrets.token_urlsafe(32),secrets.token_urlsafe(24)
    with s.transaction() as db:
        db.add(s.LoginSession(token_hash=hashlib.sha256(token.encode()).hexdigest(),csrf=csrf,expires=int(time.time()*1000)+600000))
        alerts=[]
        expected={}
        for ident in IDENTITIES:
            inst=db.get(s.Instrument,ident)
            for frame in ('M1','M30','W1','MN'):
                config=AlertConfig.model_validate(dict(name='Issue13 consumer '+ident+' '+frame,
                    instrument=ident,source=inst.source,timeframe=frame,published=True,calculation_origin=START,
                    mode='close',condition=dict(relation='cross_up',right=dict(kind='constant',value=100000)),
                    notify_web=False,notify_ntfy=False))
                alert=create(db,'issue13-consumer-'+ident+'-'+frame,config,at=NOW)
                alerts.append(alert.id)
                expected[ident,frame]=read_rows(db,inst,frame,NOW+1,500,dataset_start=START)
                assert expected[ident,frame],(ident,frame,'nonempty consumer fixture required')
    # Warm each alert before the repeated unchanged evaluation window.
    for ident in alerts:
        with s.transaction() as db:
            assert evaluate(db,ident,now=NOW)==[]
    queries=Counter()
    scope='api'
    def count(conn,cursor,statement,*args):
        queries[scope+'_sql']+=1
        for token,label in [('FROM candles','staging_reads'),('FROM chart_published_bars','published_reads'),('FROM audit_events','audit_reads')]:
            if token in statement:queries[scope+'_'+label]+=1
    event.listen(s.engine,'before_cursor_execute',count)
    api_samples=[]
    alert_samples=[]
    begun,cpu=time.monotonic(),time.process_time()
    try:
        # ASGITransport invokes actual routing/dependencies/serialization and PG,
        # without starting lifespan provider prewarm or a network listener.
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://localhost',
                cookies={'session':token},headers={'x-csrf-token':csrf}) as client:
            for repetition in range(3):
                for (ident,frame),bars in expected.items():
                    t=time.monotonic()
                    response=await client.post('/api/charts/data',json=dict(instrument=ident,timeframe=frame,
                        published=True,dataset_start=START,before=NOW+1,limit=500))
                    elapsed=time.monotonic()-t
                    assert response.status_code==200,(ident,frame,response.status_code)
                    payload=response.json()
                    assert payload['bars']==bars,(ident,frame,'published API payload mismatch')
                    api_samples.append(dict(instrument=ident,frame=frame,repetition=repetition,seconds=elapsed,bars=len(bars)))
        scope='alert'
        for repetition in range(3):
            for ident in alerts:
                t=time.monotonic()
                with s.transaction() as db:
                    assert evaluate(db,ident,now=NOW)==[]
                    alert=db.get(s.ChartAlert,ident)
                    assert alert.count==0
                    health=alert.health
                alert_samples.append(dict(alert_index=alerts.index(ident),repetition=repetition,seconds=time.monotonic()-t,health=health))
    finally:
        event.remove(s.engine,'before_cursor_execute',count)
    elapsed=time.monotonic()-begun
    report=dict(duration=elapsed,process_cpu_percent=100*(time.process_time()-cpu)/elapsed,
        api_latency=stats([r['seconds'] for r in api_samples]),alert_latency=stats([r['seconds'] for r in alert_samples]),
        queries=dict(queries),api_samples=api_samples,alert_samples=alert_samples,
        scope='Sequential in-process authenticated ASGI + isolated PostgreSQL; warm alert evaluations; local small read fix present',
        fixture='Explicit expanded history plan; all 40 instrument-period read inputs nonempty, not entire history backfill completion',
        limitations=['No API network server/lifespan, provider threads, browser, concurrent workload or input-to-alert delay',
                    'Synthetic clock fixed consistently for alert evaluation; this is service time, not upstream SLA',
                    'Read-side expected payload comes from published read_rows; not independent correctness oracle for stored OHLC'])
    write_json(target.name,report)
    print(json.dumps({k:report[k] for k in ('duration','api_latency','alert_latency','queries')}),flush=True)


if __name__=='__main__': asyncio.run(main())
