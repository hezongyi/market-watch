"""Sustained same-price publication -> intrabar freshness through real PG workers.

Ten synthetic identities, unchanged completed M1, real elapsed fixture clock.
No provider, HTTP/server, browser or notification delivery.
"""
import hashlib
import json
import threading
import time
from collections import Counter
from pathlib import Path

from sqlalchemy import event, select

import pg_baseline as b
from alerts.chart_alert_service import AlertConfig, create
from alerts.chart_alert_worker import evaluate, step
from supplemental_probe import quantiles

s, m = b.s, b.m
ROOT = Path('/results/observation-alert')
TIMES = (10, 55, 100, 235, 280)
SECONDS = 330


def stable_payload(payload):
    return {k:v for k,v in payload.items() if k!='observed_at'}


def main():
    ROOT.mkdir(exist_ok=True)
    if (ROOT/'result.json').exists() or (ROOT/'timeline.jsonl').exists():
        raise SystemExit('Observation evidence exists; deliberately archive before rerun')
    b.reset()
    start = b.NOW-5000-b.MINUTE
    execution=str(time.time_ns())
    alerts={}
    before={}
    with s.transaction() as db:
        for record in db.scalars(select(s.ChartAlert).where(s.ChartAlert.status=='active')):
            record.status='paused'
        for ident in b.IDENTITIES:
            inst=db.get(s.Instrument,ident)
            bar=db.scalar(select(s.Bar).where(s.Bar.instrument_id==ident,
                s.Bar.timeframe=='M1',s.Bar.start==start))
            published=db.get(s.ChartPublishedBar,(ident,'M1',start))
            assert bar.observed_at==b.NOW and published.payload['observed_at']==b.NOW
            before[ident]=dict(payload=published.payload,source_price_revision=bar.revision,
                source_volume_revision=bar.volume_revision,published_row_revision=published.revision)
            config=AlertConfig.model_validate(dict(name='Issue13 observed '+ident,instrument=ident,
                source=inst.source,timeframe='M1',mode='intrabar',published=True,
                calculation_origin=b.NOW-5000-120*b.MINUTE,max_triggers=3,
                condition=dict(relation='cross_up',right=dict(kind='constant',value=100000)),
                notify_web=False,notify_ntfy=False))
            alerts[ident]=create(db,'issue13-observation-'+execution+'-'+ident,config,at=b.NOW).id
    for ident,alert_id in alerts.items():
        with s.transaction() as db:
            assert evaluate(db,alert_id,now=b.NOW)==[]
            record=db.get(s.ChartAlert,alert_id)
            assert record.health=='ready' and record.state['sequence']==b.NOW

    begun=time.monotonic()
    clock=lambda:b.NOW+int(1000*(time.monotonic()-begun))
    m.now_ms=clock
    s.now_ms=clock
    from alerts import bar_batch
    bar_batch.now_ms=clock
    m._PUBLISH_CURSOR=None
    stop=threading.Event()
    errors=[]
    turns=[]
    steps=[]
    inputs=[]
    samples=[]
    queries=Counter()

    def count(conn,cursor,statement,*args):
        scope={'observation-publisher':'publisher','observation-alert':'alert',
            'observation-sampler':'sampler'}.get(threading.current_thread().name,'input')
        queries[scope+'_sql']+=1
        for token,label in [('FROM candles','staging_reads'),('FROM audit_events','audit_reads'),
                ('FROM chart_published_bars','published_reads')]:
            if token in statement:queries[scope+'_'+label]+=1

    def run_guard(scope,fn):
        try:fn()
        except Exception as error:
            errors.append(dict(scope=scope,error=type(error).__name__))
            stop.set()

    def publisher():
        while not stop.is_set():
            at=time.monotonic()
            aggregate,publish=b.cycle()
            turns.append(dict(at=at-begun,seconds=time.monotonic()-at,
                target=m._PUBLISH_CURSOR,aggregate=aggregate,publish=publish))
            stop.wait(.1 if aggregate or publish else 1)

    def monitor():
        while not stop.is_set():
            at=time.monotonic()
            step(now=clock())
            steps.append(dict(at=at-begun,end=time.monotonic()-begun))
            stop.wait(1)

    def sampler():
        with (ROOT/'timeline.jsonl').open('x') as output:
            while not stop.is_set():
                at=time.monotonic()-begun
                with s.transaction() as db:
                    payloads={row.instrument_id:row.payload for row in db.scalars(
                        select(s.ChartPublishedBar).where(s.ChartPublishedBar.timeframe=='M1',
                            s.ChartPublishedBar.start==start))}
                    records={ident:db.get(s.ChartAlert,alert_id) for ident,alert_id in alerts.items()}
                    data={ident:dict(published_observed_at=payloads[ident]['observed_at'],
                        sequence=record.state.get('sequence'),health=record.health,count=record.count,
                        status=record.status) for ident,record in records.items()}
                    assert all(stable_payload(payloads[ident])==stable_payload(before[ident]['payload'])
                        for ident in alerts), 'Same-price publication changed stable payload'
                row=dict(query_start_seconds=at,observed_seconds=time.monotonic()-begun,
                    consumer_clock=clock(),identities=data)
                samples.append(row)
                output.write(json.dumps(row)+'\n')
                output.flush()
                stop.wait(.2)

    workers=[threading.Thread(target=lambda scope=scope,fn=fn:run_guard(scope,fn),name=scope)
        for scope,fn in [('observation-publisher',publisher),('observation-alert',monitor),
            ('observation-sampler',sampler)]]
    cgroup_before={name:(Path('/sys/fs/cgroup')/name).read_text() for name in
        ('cpu.stat','memory.current','memory.events') if (Path('/sys/fs/cgroup')/name).exists()}
    cpu=time.process_time()
    event.listen(s.engine,'before_cursor_execute',count)
    try:
        for worker in workers:worker.start()
        for batch,when in enumerate(TIMES):
            if stop.wait(max(0,when-(time.monotonic()-begun))):break
            for ident in b.IDENTITIES:
                source_clock=clock()
                with s.transaction() as db:
                    row=db.scalar(select(s.Bar).where(s.Bar.instrument_id==ident,
                        s.Bar.timeframe=='M1',s.Bar.start==start))
                    revision,volume_revision=row.revision,row.volume_revision
                    changes=b.write_bars(db,ident,'M1',[row.candle()],observed_at=source_clock)
                    db.refresh(row)
                    assert not changes.price and not changes.volume
                    assert (row.revision,row.volume_revision)==(revision,volume_revision)
                    assert row.observed_at==source_clock and row.received_at<=clock()
                    assert stable_payload(s.candle_dict(row.candle()))==stable_payload(before[ident]['payload'])
                    commit_begin=time.monotonic()-begun
                inputs.append(dict(instrument=ident,batch=batch,scheduled_seconds=when,
                    source_observed_at=source_clock,committed_seconds=time.monotonic()-begun,
                    commit_window_begin_seconds=commit_begin,
                    source_price_revision=revision,source_volume_revision=volume_revision))
            print(f'Observation batch {batch+1}/5 committed for ten identities',flush=True)
        stop.wait(max(0,SECONDS-(time.monotonic()-begun)))
    finally:
        duration=time.monotonic()-begun
        used_cpu=time.process_time()-cpu
        stop.set()
        for worker in workers:
            if worker.ident:worker.join(timeout=20)
        event.remove(s.engine,'before_cursor_execute',count)
    assert all(not worker.is_alive() for worker in workers), 'Observation thread did not stop'
    cgroup_after={name:(Path('/sys/fs/cgroup')/name).read_text() for name in cgroup_before}
    final={}
    with s.transaction() as db:
        for ident,alert_id in alerts.items():
            record=db.get(s.ChartAlert,alert_id)
            published=db.get(s.ChartPublishedBar,(ident,'M1',start))
            source=db.scalar(select(s.Bar).where(s.Bar.instrument_id==ident,
                s.Bar.timeframe=='M1',s.Bar.start==start))
            signals=list(db.scalars(select(s.SignalRow.id).where(s.SignalRow.chart_alert_id==alert_id)))
            final[ident]=dict(count=record.count,signal_count=len(signals),
                health=record.health,status=record.status,sequence=record.state.get('sequence'),
                source_price_revision=source.revision,source_volume_revision=source.volume_revision,
                source_observed_at=source.observed_at,published_payload=published.payload,
                published_row_revision=published.revision)
    outcomes=[]
    for item in inputs:
        ident,expected=item['instrument'],item['source_observed_at']
        # Exact observation markers are preserved. Coalesced/skipped markers
        # remain missing instead of being counted as exact successful events.
        visible=next((sample for sample in samples if
            sample['identities'][ident]['published_observed_at']==expected),None)
        judged=next((sample for sample in samples if
            sample['identities'][ident]['sequence']==expected),None)
        outcomes.append(dict(**item,visible_seconds=visible['observed_seconds'] if visible else None,
            judged_seconds=judged['observed_seconds'] if judged else None,
            commit_to_visible=visible['observed_seconds']-item['committed_seconds'] if visible else None,
            visible_to_judged=judged['observed_seconds']-visible['observed_seconds'] if visible and judged else None,
            judgment_health=judged['identities'][ident]['health'] if judged else None))
    freshness={}
    for ident in alerts:
        batches=[item for item in inputs if item['instrument']==ident]
        latest_before_pause=batches[2]['source_observed_at'] if len(batches)>2 else None
        stale=next((sample for sample in samples if sample['observed_seconds']<235 and
            sample['identities'][ident]['health']=='stale'),None)
        recovered=next((sample for sample in samples if sample['observed_seconds']>=235 and
            sample['identities'][ident]['health']=='ready' and
            sample['identities'][ident]['sequence']>latest_before_pause),None) if latest_before_pause else None
        freshness[ident]=dict(first_stale_seconds=stale['observed_seconds'] if stale else None,
            observed_age_at_first_stale_ms=stale['consumer_clock']-stale['identities'][ident]['published_observed_at'] if stale else None,
            first_recovered_seconds=recovered['observed_seconds'] if recovered else None,
            final_ready=final[ident]['health']=='ready')
    report=dict(outcome='measured',duration=duration,seconds_requested=SECONDS,
        schedule_seconds=list(TIMES),clock='Fixture epoch + actual monotonic elapsed; no event-count jumps',
        identity_count=10,inputs=len(inputs),visible=sum(item['visible_seconds'] is not None for item in outcomes),
        judged=sum(item['judged_seconds'] is not None for item in outcomes),
        events=outcomes,freshness=freshness,before=before,final=final,
        publisher_turns=turns,alert_steps=steps,sample_count=len(samples),errors=errors,
        queries=dict(queries),process_cpu_percent=100*used_cpu/duration,
        cgroup_before=cgroup_before,cgroup_after=cgroup_after,
        commit_to_visible_completed=quantiles([item['commit_to_visible'] for item in outcomes if item['commit_to_visible'] is not None]),
        visible_to_judged_completed=quantiles([item['visible_to_judged'] for item in outcomes if item['visible_to_judged'] is not None]),
        scope='Real aggregate_once/publish_once + one-second alert step + PG sampling; same completed M1 candle, no new minutes',
        limitations=['One 330-second synthetic run; no successful provider I/O, network, API lifespan, browser or notifications',
            'Same completed candle observes newer sample markers; not actual quote arrival or complete-close SLA',
            'Sampler uses read-committed sequential SELECTs; timestamps include pool/scheduling uncertainty and commit-return overlap',
            'Exact marker misses/coalescing remain in denominator; latency uses completed observations only',
            'Idle-gap stale/recovery is intrabar freshness, not high-period trigger or migration/crash acceptance'],
        source_sha256={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in
            [Path(__file__),Path('backend/alerts/managed_dataset.py'),Path('backend/alerts/chart_alert_worker.py'),
                Path('backend/alerts/bar_batch.py')]})
    (ROOT/'result.json').write_text(json.dumps(report,indent=2)+'\n')
    assert not errors and len(inputs)==50
    assert all(final[ident]['count']==final[ident]['signal_count']==0 for ident in alerts)
    assert all(final[ident]['status']=='active' for ident in alerts)
    assert all(item['first_stale_seconds'] is not None and item['first_recovered_seconds'] is not None
        and item['final_ready'] for item in freshness.values()), 'Freshness lifecycle incomplete'
    assert all(stable_payload(final[ident]['published_payload'])==stable_payload(before[ident]['payload'])
        and final[ident]['source_price_revision']==before[ident]['source_price_revision']
        and final[ident]['source_volume_revision']==before[ident]['source_volume_revision'] for ident in alerts)
    assert queries.get('alert_staging_reads',0)==queries.get('alert_audit_reads',0)==0
    report['outcome']='passed'
    (ROOT/'result.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({k:report[k] for k in ['outcome','duration','inputs','visible','judged',
        'commit_to_visible_completed','visible_to_judged_completed','errors']}),flush=True)


if __name__=='__main__':
    main()
