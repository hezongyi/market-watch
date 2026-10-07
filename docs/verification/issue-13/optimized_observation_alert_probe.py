"""Sustained same-price publication -> intrabar freshness through real PG workers.

Ten synthetic identities, unchanged completed M1, real elapsed fixture clock.
No provider, HTTP/server, browser or notification delivery.
"""
import hashlib
import json
import os
import threading
import time
from collections import Counter
from pathlib import Path

from sqlalchemy import event, select

import pg_baseline as b
from alerts.chart_alert_service import AlertConfig, create
from alerts.chart_alert_worker import evaluate
from alerts.alert_monitor import run as run_monitor
from measurement_windows import latency_window
from observation_sampling import read_sample
from supplemental_probe import quantiles

s, m = b.s, b.m
NORMAL = os.environ.get('ISSUE13_NORMAL_INPUT') == '1'
ROOT = Path('/results/normal-input-alert' if NORMAL else '/results/observation-alert')
TIMES = tuple(range(10, 311, 10)) if NORMAL else (10, 55, 100, 235, 280)
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
    from alerts import bar_batch, chart_alert_worker, composite_watches
    bar_batch.now_ms=clock
    chart_alert_worker.now_ms=clock
    composite_watches.now_ms=clock
    m._PUBLISH_CURSOR=None
    stop=threading.Event()
    errors=[]
    turns=[]
    steps=[]
    inputs=[]
    samples=[]
    judgments=[]
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
        from alerts.publication_wakeup import PublicationWakeup
        with PublicationWakeup(s.engine) as wakeup:
            while not stop.is_set():
                prepare_at=time.monotonic()
                wakeup.prepare()
                prepare_seconds=time.monotonic()-prepare_at
                at=time.monotonic()
                stages=[]
                aggregate,publish=b.cycle(observer=stages.append)
                record=dict(at=at-begun,seconds=time.monotonic()-at,
                    listener_prepare_seconds=prepare_seconds,
                    target=publish.selected_target,aggregate=aggregate,publish=bool(publish),
                    attempted=publish.attempted,task_progressed=publish.task_progressed,
                    snapshot_changed=publish.snapshot_changed,runnable_remaining=publish.runnable_remaining,
                    next_due_at=publish.next_due_at,blocked_reason=publish.blocked_reason,
                    publication_call_seconds=stages[0]['publication_finished']-stages[0]['publication_started'],
                    aggregation_call_seconds=stages[0]['aggregation_finished']-stages[0]['aggregation_started'])
                delay=b.wait_seconds(aggregate,publish)
                wait_at=time.monotonic()
                record['requested_wait_seconds']=delay
                record['wake_reason']=wakeup.wait(delay,stop)
                record['actual_wait_seconds']=time.monotonic()-wait_at
                record['listener_error']=wakeup.error
                turns.append(record)

    def monitor():
        def committed(row):
            judgments.append({**row, **{key:row[key]-begun for key in
                ('read_started', 'commit_started', 'committed')}})
        def turn(row):
            if row['error']:
                errors.append(dict(scope='monitor',error=row['error']))
            steps.append(dict(at=row['started']-begun, end=row['finished']-begun,
                chart_seconds=row['chart_finished']-row['started'],
                watch_seconds=row['finished']-row['chart_finished'],
                overrun=row['overrun'], error=row['error']))
        run_monitor(stop, on_alert=committed, on_turn=turn)

    def sampler():
        with (ROOT/'timeline.jsonl').open('x') as output:
            while not stop.is_set():
                at=time.monotonic()-begun
                sql_before=queries['sampler_sql']
                with s.transaction() as db:
                    data=read_sample(db, alerts, start=None if NORMAL else start)
                    if not NORMAL:
                        assert all(stable_payload(data[ident]['payload'])==stable_payload(before[ident]['payload'])
                            for ident in alerts), 'Same-price publication changed stable payload'
                row=dict(query_start_seconds=at,observed_seconds=time.monotonic()-begun,
                    consumer_clock=clock(),identities=data,
                    sampler_sql=queries['sampler_sql']-sql_before)
                samples.append(row)
                output.write(json.dumps(row)+'\n')
                output.flush()
                stop.wait(.05)

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
                        s.Bar.timeframe=='M1').order_by(s.Bar.start.desc()).limit(1))
                    revision,volume_revision=row.revision,row.volume_revision
                    kind='same_price'
                    if NORMAL:
                        latest=(source_clock-5000)//b.MINUTE*b.MINUTE-b.MINUTE
                        kind='new_minute' if latest>row.start else ('price_revision' if batch%3==1
                            else 'volume_revision' if batch%3==2 else 'same_price')
                        from dataclasses import replace
                        candle=row.candle()
                        if kind=='new_minute':
                            candle=replace(candle,start=s.instant(latest),end=s.instant(latest+b.MINUTE))
                        elif kind=='price_revision':
                            candle=replace(candle,close=candle.close+1,high=candle.high+1)
                        elif kind=='volume_revision':
                            candle=replace(candle,volume=(candle.volume or 0)+1)
                        inst=db.get(s.Instrument,ident)
                        b.ingest(db,inst,dict(source=inst.source,basis=inst.basis,
                            rows=[dict(s.candle_dict(candle),timestamp=s.ms(candle.start))],
                            coverage=[dict(start=s.ms(candle.start),end=s.ms(candle.end))]),
                            received_at=source_clock,defer_aggregation=True)
                        row=db.scalar(select(s.Bar).where(s.Bar.instrument_id==ident,
                            s.Bar.timeframe=='M1',s.Bar.start==s.ms(candle.start)))
                        db.refresh(row)
                    else:
                        changes=b.write_bars(db,ident,'M1',[row.candle()],observed_at=source_clock)
                        db.refresh(row)
                        assert not changes.price and not changes.volume
                        assert (row.revision,row.volume_revision)==(revision,volume_revision)
                    assert row.observed_at==source_clock and row.received_at<=clock()
                    if not NORMAL:
                        assert stable_payload(s.candle_dict(row.candle()))==stable_payload(before[ident]['payload'])
                    expected_payload=s.candle_dict(row.candle())
                    expected_payload['observed_at']=source_clock
                    commit_begin=time.monotonic()-begun
                inputs.append(dict(instrument=ident,batch=batch,scheduled_seconds=when,
                    kind=kind,source_start=row.start,
                    expected_payload=expected_payload,
                    source_observed_at=source_clock,committed_seconds=time.monotonic()-begun,
                    commit_window_begin_seconds=commit_begin,
                    source_price_revision=revision,source_volume_revision=volume_revision))
            print(f'Observation batch {batch+1}/{len(TIMES)} committed for ten identities',flush=True)
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
            published=db.scalar(select(s.ChartPublishedBar).where(s.ChartPublishedBar.instrument_id==ident,
                s.ChartPublishedBar.timeframe=='M1').order_by(s.ChartPublishedBar.start.desc()).limit(1))
            source=db.scalar(select(s.Bar).where(s.Bar.instrument_id==ident,
                s.Bar.timeframe=='M1').order_by(s.Bar.start.desc()).limit(1))
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
        if visible:
            assert visible['identities'][ident]['payload']==item['expected_payload'], 'Exact marker payload differs'
        judged=next((row for row in judgments if row['alert_id']==alerts[ident]
            and row['sequence']==expected),None)
        absent=[sample['query_start_seconds'] for sample in samples if visible and
            sample['observed_seconds']<visible['observed_seconds'] and
            sample['identities'][ident]['published_observed_at']!=expected]
        publication_window=(max(absent + [item['commit_window_begin_seconds']]),
                            visible['observed_seconds']) if visible else None
        window=latency_window(publication_window,
            (judged['commit_started'],judged['committed']) if judged else None)
        outcomes.append(dict(**item,visible_seconds=visible['observed_seconds'] if visible else None,
            alert_id=alerts[ident],
            judged_seconds=judged['committed'] if judged else None,
            commit_to_visible=visible['observed_seconds']-item['committed_seconds'] if visible else None,
            visible_to_judged=judged['committed']-visible['observed_seconds'] if visible and judged else None,
            judgment_health=judged['health'] if judged else None, latency_interval=window))
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
        publisher_turns=turns,alert_steps=steps,alert_commits=judgments,sample_count=len(samples),errors=errors,
        queries=dict(queries),process_cpu_percent=100*used_cpu/duration,
        cgroup_before=cgroup_before,cgroup_after=cgroup_after,
        commit_to_visible_completed=quantiles([item['commit_to_visible'] for item in outcomes if item['commit_to_visible'] is not None]),
        visible_to_judged_completed=quantiles([item['visible_to_judged'] for item in outcomes if item['visible_to_judged'] is not None]),
        visible_to_judged_certified_upper=quantiles([item['latency_interval']['upper_seconds']
            for item in outcomes if item['latency_interval'] is not None]),
        scope='Real aggregate_once/publish_once + shared production monitor cadence + PG sampling; same completed M1 candle, no new minutes',
        limitations=['One 330-second synthetic run; no successful provider I/O, network, API lifespan, browser or notifications',
            'Same completed candle observes newer sample markers; not actual quote arrival or complete-close SLA',
            'Sampler uses read-committed sequential SELECTs; timestamps include pool/scheduling uncertainty and commit-return overlap',
            'Exact marker misses/coalescing remain in denominator; latency uses completed observations only',
            'Idle-gap stale/recovery is intrabar freshness, not high-period trigger or migration/crash acceptance'],
        source_sha256={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in
            [Path(__file__),Path('backend/alerts/managed_dataset.py'),Path('backend/alerts/chart_alert_worker.py'),
                Path('backend/alerts/bar_batch.py'),Path(__file__).with_name('observation_sampling.py')]})
    (ROOT/'result.json').write_text(json.dumps(report,indent=2)+'\n')
    expected_inputs=len(TIMES)*len(alerts)
    assert not errors and len(inputs)==expected_inputs
    assert report['visible']==report['judged']==expected_inputs, 'Missing exact observation markers retained'
    assert all(final[ident]['count']==final[ident]['signal_count']==0 for ident in alerts)
    assert all(final[ident]['status']=='active' for ident in alerts)
    if not NORMAL:
        assert all(item['first_stale_seconds'] is not None and item['first_recovered_seconds'] is not None
            and item['final_ready'] for item in freshness.values()), 'Freshness lifecycle incomplete'
        assert all(stable_payload(final[ident]['published_payload'])==stable_payload(before[ident]['payload'])
            and final[ident]['source_price_revision']==before[ident]['source_price_revision']
            and final[ident]['source_volume_revision']==before[ident]['source_volume_revision'] for ident in alerts)
    else:
        assert all(row['health']=='ready' for row in final.values())
        assert {'same_price','new_minute','price_revision','volume_revision'} <= {row['kind'] for row in inputs}
        report['scope']='330s sustained normal M1 input with same-price observations, new minutes, price/volume revisions; shared chart+watch monitor'
    assert queries.get('alert_staging_reads',0)==queries.get('alert_audit_reads',0)==0
    report['outcome']='passed'
    (ROOT/'result.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({k:report[k] for k in ['outcome','duration','inputs','visible','judged',
        'commit_to_visible_completed','visible_to_judged_completed','errors']}),flush=True)


if __name__=='__main__':
    main()
