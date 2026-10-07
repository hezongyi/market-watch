"""Own-PG TCP API and concurrent published-alert baseline, no upstream I/O.

Uvicorn runs the actual app with lifespan disabled. A dedicated thread invokes
the real alert step then waits one second, as provider_service does. This isolates
synthetic published consumption; it does not certify the full provider lifespan,
browser, native chart assets, upstream SLA or notification delivery.
"""
import hashlib
import json
import secrets
import threading
import time
from collections import Counter
from decimal import Decimal
from pathlib import Path

import httpx
import uvicorn
from sqlalchemy import event, func, select

import pg_baseline as b
from supplemental_probe import quantiles
from alerts.api import app
from alerts.chart_alert_service import AlertConfig, create
from alerts.chart_alert_worker import evaluate
from alerts.alert_monitor import run as run_monitor
from measurement_windows import latency_window

s, m = b.s, b.m
ROOT = Path('/results/network-alert')


def main():
    if ROOT.exists():
        raise SystemExit('Network/alert evidence exists; archive explicitly, no overwrite')
    ROOT.mkdir()
    b.reset()
    with s.transaction() as db:
        # This database contains only our synthetic consumer probes. Retain their
        # evidence, but pause their old alert runs so step evaluates ten new runs.
        for alert in db.scalars(select(s.ChartAlert).where(s.ChartAlert.status=='active')):
            alert.status = 'paused'
        for ident in b.IDENTITIES:
            m.join(db, db.get(s.Instrument,ident), b.START, b.NOW)
    for ident in b.IDENTITIES:
        for frame in ('M1','M30','W1','MN'):
            with s.transaction() as db:
                m.publish_frame(db, db.get(s.Instrument,ident), db.get(s.ChartHistoryPlan,ident), frame, b.NOW)
    token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(24)
    # Archiving output permits an intentional new measurement. Existing alert
    # request IDs and signal rows survive fixture reset, so do not reuse a run.
    execution_key=str(time.time_ns())
    alerts = {}
    with s.transaction() as db:
        db.add(s.LoginSession(token_hash=hashlib.sha256(token.encode()).hexdigest(), csrf=csrf,
            expires=int(time.time()*1000)+600000))
        for index, ident in enumerate(b.IDENTITIES):
            inst = db.get(s.Instrument,ident)
            config = AlertConfig.model_validate(dict(name='Issue13 network '+ident,
                instrument=ident,source=inst.source,timeframe='M1',published=True,
                calculation_origin=b.NOW-5000-120*b.MINUTE,max_triggers=2,
                condition=dict(relation='cross_up',right=dict(kind='constant',value=101+index)),
                notify_web=False,notify_ntfy=False))
            alerts[ident]=create(db,'issue13-network-'+execution_key+'-'+ident,config,at=b.NOW).id
    for ident in alerts.values():
        with s.transaction() as db:
            assert evaluate(db,ident,now=b.NOW)==[]
            assert db.get(s.ChartAlert,ident).health=='ready'

    # All input minutes are already finished at the measurement start. Thereafter
    # every source/consumer clock advances by actual elapsed time, without jumps.
    begun = time.monotonic()
    fixture_now = lambda: b.NOW+b.MINUTE+int(1000*(time.monotonic()-begun))
    m.now_ms = fixture_now
    s.now_ms = fixture_now
    from alerts import bar_batch, chart_aggregation, chart_alert_worker, composite_watches, market, publication_jobs
    for module in (bar_batch,chart_aggregation,chart_alert_worker,composite_watches,market,publication_jobs):
        module.now_ms=fixture_now
    m._PUBLISH_CURSOR = None
    stop = threading.Event()
    errors, worker_turns, alert_turns, visible, judged = [], [], [], {}, {}
    api_samples, events = [], []
    absent, alert_commits = {}, []
    query_counts=Counter()
    def count(conn,cursor,statement,*args):
        scope={'issue13-publisher':'publisher','issue13-alert':'alert',
            'AnyIO worker thread':'api'}.get(threading.current_thread().name,'verification')
        if threading.get_ident()==server_thread.ident:
            scope='api'
        query_counts[scope+'_sql']+=1
        for token,label in [('FROM candles','staging_reads'),('FROM audit_events','audit_reads'),
                ('FROM chart_published_bars','published_reads')]:
            if token in statement:query_counts[scope+'_'+label]+=1

    server=uvicorn.Server(uvicorn.Config(app,host='0.0.0.0',port=8000,
        lifespan='off',log_level='warning',access_log=False))
    server_thread=threading.Thread(target=server.run,daemon=True)

    def aggregate():
        try:
            from alerts.publication_wakeup import PublicationWakeup
            with PublicationWakeup(s.engine) as wakeup:
                while not stop.is_set():
                    wakeup.prepare()
                    t=time.monotonic()
                    a,p=b.cycle()
                    worker_turns.append(dict(at=t-begun,seconds=time.monotonic()-t,
                        target=p.selected_target,aggregate=a,publish=bool(p),
                        attempted=p.attempted,runnable_remaining=p.runnable_remaining))
                    wakeup.wait(b.wait_seconds(a,p),stop)
        except Exception as exc:
            errors.append(dict(scope='publisher',error=type(exc).__name__))
            stop.set()

    def monitor():
        try:
            reverse={value:key for key,value in alerts.items()}
            def committed(row):
                row={**row, **{key:row[key]-begun for key in
                    ('read_started','commit_started','committed')}}
                alert_commits.append(row)
                ident=reverse.get(row['alert_id'])
                if ident and row['count'] and ident not in judged:
                    judged[ident]=dict(at=row['committed'],commit_started=row['commit_started'],
                        health=row['health'],count=row['count'],state_sequence=row['sequence'])
            def turn(row):
                if row['error']:
                    errors.append(dict(scope='monitor',error=row['error']))
                alert_turns.append(dict(at=row['started']-begun,
                    seconds=row['finished']-row['started'],
                    chart_seconds=row['chart_finished']-row['started'],
                    watch_seconds=row['finished']-row['chart_finished'],
                    overrun=row['overrun'],error=row['error']))
            run_monitor(stop,on_alert=committed,on_turn=turn)
        except Exception as exc:
            errors.append(dict(scope='alert',error=type(exc).__name__))
            stop.set()

    def observe_visible():
        try:
            while not stop.is_set():
                t=time.monotonic()-begun
                with s.transaction() as db:
                    rows=list(db.scalars(select(s.ChartPublishedBar).where(
                        s.ChartPublishedBar.timeframe=='M1',s.ChartPublishedBar.start==b.NOW-5000)))
                at=time.monotonic()-begun
                found={row.instrument_id for row in rows}
                for ident in b.IDENTITIES:
                    if ident not in found:
                        absent[ident]=t
                for row in rows:
                    if row.instrument_id not in visible:
                        visible[row.instrument_id]=dict(at=at,query_start=t,
                            last_absent_start=absent.get(row.instrument_id,0),payload=row.payload)
                stop.wait(.05)
        except Exception as exc:
            errors.append(dict(scope='visibility',error=type(exc).__name__))
            stop.set()

    def requests():
        try:
            with httpx.Client(base_url='http://127.0.0.1:8000',cookies={'session':token},
                    headers={'x-csrf-token':csrf},timeout=10) as client:
                assert httpx.get('http://127.0.0.1:8000/api/instruments').status_code==401
                for repetition in range(3):
                    for ident in b.IDENTITIES:
                        for frame in ('M1','M30','W1','MN'):
                            if stop.is_set():return
                            t=time.monotonic()
                            response=client.post('/api/charts/data',json=dict(instrument=ident,
                                timeframe=frame,published=True,dataset_start=b.START,
                                before=fixture_now()+1,limit=500))
                            seconds=time.monotonic()-t
                            assert response.status_code==200
                            bars=response.json()['bars']
                            assert bars and len(bars)<=500
                            api_samples.append(dict(at=t-begun,instrument=ident,frame=frame,
                                repetition=repetition,seconds=seconds,bars=len(bars)))
                            stop.wait(.5)
        except Exception as exc:
            errors.append(dict(scope='network_api',error=type(exc).__name__))
            stop.set()

    threads=[server_thread]+[threading.Thread(target=fn,daemon=True,name=name)
        for fn,name in [(aggregate,'issue13-publisher'),(monitor,'issue13-alert'),
            (observe_visible,'issue13-visibility'),(requests,'issue13-client')]]
    cgroup_before={name:(Path('/sys/fs/cgroup')/name).read_text()
        for name in ('cpu.stat','memory.current','memory.events') if (Path('/sys/fs/cgroup')/name).exists()}
    cpu_begun=time.process_time()
    event.listen(s.engine,'before_cursor_execute',count)
    try:
        server_thread.start()
        for _ in range(200):
            if server.started:break
            time.sleep(.05)
        assert server.started,'TCP API server did not start'
        for thread in threads[1:]:thread.start()
        for index,ident in enumerate(b.IDENTITIES):
            if stop.wait(max(0,10+index*3-(time.monotonic()-begun))):break
            with s.transaction() as db:
                inst=db.get(s.Instrument,ident)
                price=Decimal(102+index)
                b.ingest(db,inst,dict(source=inst.source,basis=inst.basis,
                    rows=[dict(timestamp=b.NOW-5000,open=str(price),high=str(price+1),
                        low=str(price-1),close=str(price),complete=True,volume=1)],
                    coverage=[dict(start=b.NOW-5000,end=b.NOW-5000+b.MINUTE)]),
                    received_at=fixture_now(),defer_aggregation=True)
                source=db.scalar(select(s.Bar).where(s.Bar.instrument_id==ident,
                    s.Bar.timeframe=='M1',s.Bar.start==b.NOW-5000))
                source_received,source_observed=source.received_at,source.observed_at
                assert source_received<=fixture_now() and source_observed<=fixture_now()
            events.append(dict(instrument=ident,committed_seconds=time.monotonic()-begun,
                expected_close=str(price),expected_end=b.NOW-5000+b.MINUTE,
                source_received_at=source_received,source_observed_at=source_observed))
        stop.wait(max(0,120-(time.monotonic()-begun)))
    finally:
        duration=time.monotonic()-begun
        cpu=time.process_time()-cpu_begun
        stop.set()
        server.should_exit=True
        for thread in threads:
            if thread.ident:thread.join(timeout=15)
        event.remove(s.engine,'before_cursor_execute',count)
    cgroup_after={name:(Path('/sys/fs/cgroup')/name).read_text() for name in cgroup_before}
    assert all(not thread.is_alive() for thread in threads),'probe thread failed to stop'
    with s.transaction() as db:
        final={ident:dict(count=db.get(s.ChartAlert,alert_id).count,
            health=db.get(s.ChartAlert,alert_id).health,
            signal_count=db.scalar(select(func.count()).select_from(s.SignalRow).where(s.SignalRow.chart_alert_id==alert_id)))
            for ident,alert_id in alerts.items()}
    outcomes=[]
    for item in events:
        ident=item['instrument']
        v,j=visible.get(ident),judged.get(ident)
        window=latency_window((v['last_absent_start'],v['at']) if v else None,
            (j['commit_started'],j['at']) if j else None)
        if v:
            assert Decimal(v['payload']['close'])==Decimal(item['expected_close'])
            assert v['payload']['end']==item['expected_end']
        outcomes.append(dict(**item,visibility=v,judgment=j,
            commit_to_visible=v['at']-item['committed_seconds'] if v else None,
            # A sampling estimate, not a rigorous bound: scheduling and the
            # previous query's duration can add uncertainty beyond 50ms.
            visible_to_judged=j['at']-v['at'] if v and j else None,
            visible_to_judged_upper=window['upper_seconds'] if window else None,
            latency_interval=window,
            final=final[ident]))
    report=dict(duration=duration,process_cpu_percent=100*cpu/duration,
        execution_key=execution_key,
        queries=dict(query_counts),cgroup_before=cgroup_before,cgroup_after=cgroup_after,
        api=dict(count=len(api_samples),**quantiles([r['seconds'] for r in api_samples])),
        alert_latency_completed_only=quantiles([r['visible_to_judged'] for r in outcomes if r['visible_to_judged'] is not None]),
        alert_latency_certified_upper=quantiles([r['visible_to_judged_upper'] for r in outcomes
            if r['visible_to_judged_upper'] is not None]),
        inputs=len(events),visible=len(visible),judged=len(judged),events=outcomes,
        api_samples=api_samples,worker_turns=worker_turns,alert_turns=alert_turns,alert_commits=alert_commits,errors=errors,
        scope='Actual TCP Uvicorn routing/authentication + real publisher and one-second alert step, isolated synthetic PG',
        limitations=['Lifespan disabled: no provider prewarm/acquisition/native MCP transport',
            'TCP client runs inside the same container; host mapping checked separately',
            'No full webpage, browser, upstream data, external notifications or production SLA',
            'Visibility and judgment timestamps are observed after commit; latency bounds include poll uncertainty',
            'Ten new-minute triggers, not observation-only freshness, high-period triggers or full sustained workload'])
    (ROOT/'result.json').write_text(json.dumps(report,indent=2,default=str)+'\n')
    print(json.dumps({k:report[k] for k in ['duration','process_cpu_percent','api',
        'alert_latency_completed_only','inputs','visible','judged','errors']}),flush=True)
    assert not errors and len(api_samples)==120 and len(events)==10
    assert len(visible)==len(judged)==10,'Unpublished/unjudged inputs retained; baseline not complete'
    assert all(r['count']==r['signal_count']==1 for r in final.values()),'Missing trigger or duplicate event'
    assert query_counts.get('api_staging_reads',0)==query_counts.get('alert_staging_reads',0)==0
    assert query_counts.get('api_audit_reads',0)==query_counts.get('alert_audit_reads',0)==0


if __name__=='__main__':main()
