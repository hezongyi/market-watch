"""Independent high-period oracle and authenticated consumer consistency in own PG.

Uses real product routes/SDK/PG, no API provider lifespan, network or notifications.
"""
import asyncio
import csv
import gzip
import hashlib
import io
import json
import secrets
import time
from dataclasses import replace
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace

import httpx
from fastapi import FastAPI
from sqlalchemy import delete, select

import pg_baseline as b
from high_period_oracle import expected
from alerts import bar_batch
from alerts.api import app
from alerts.chart_alert_service import AlertConfig
from alerts.chart_alert_worker import stored_rows
from alerts.mcp.auth import digest, issue
from alerts.mcp.server import create_server
from alerts.config import settings

s, m = b.s, b.m
ROOT = Path('/results/high-period')
FRAMES = ('M30', 'W1', 'MN')


def sha(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def source_inputs():
    result = {}
    with s.transaction() as db:
        for ident in b.IDENTITIES:
            inst = db.get(s.Instrument, ident)
            meta = dict(instrument=ident, **{k:getattr(inst, k) for k in
                ('source','symbol','basis','calendar','calendar_profile','precision')})
            frames = {}
            for frame in ('M15','D1'):
                frames[frame] = [dict(start=r.start, end=r.end, open=str(r.open),
                    high=str(r.high), low=str(r.low), close=str(r.close), complete=r.complete,
                    revision=r.revision, volume=format(r.volume, 'f') if r.volume is not None else None,
                    volume_complete=r.volume_complete, observed_at=r.observed_at,
                    received_at=r.received_at) for r in db.scalars(select(s.Bar).where(
                        s.Bar.instrument_id==ident, s.Bar.timeframe==frame).order_by(s.Bar.start))]
            result[ident] = dict(meta=meta, frames=frames)
    return result


def publication_passes():
    # Four bounded passes cover M30 at the candidate source-row budget.
    # The fixture and independent oracle remain unchanged.
    for _ in range(4):
        for ident in b.IDENTITIES:
            for frame in FRAMES:
                with s.transaction() as db:
                    inst=db.scalar(select(s.Instrument).where(s.Instrument.id==ident).with_for_update())
                    m.publish_frame(db, inst, db.get(s.ChartHistoryPlan, ident), frame, b.clock)


def full_snapshots():
    result = {}
    with s.transaction() as db:
        for ident in b.IDENTITIES:
            for frame in FRAMES:
                result[ident+'/'+frame] = dict(
                    publication={k:getattr(db.get(s.ChartPublication,(ident,frame)), k) for k in
                        ('start','end','complete_count','revision','initialized')},
                    rows=[dict(payload=r.payload, row_revision=r.revision) for r in db.scalars(
                        select(s.ChartPublishedBar).where(s.ChartPublishedBar.instrument_id==ident,
                            s.ChartPublishedBar.timeframe==frame).order_by(s.ChartPublishedBar.start))])
    return result


def mutate(observation_only=False):
    changed = []
    for ident in b.IDENTITIES:
        for frame in ('M15','D1'):
            with s.transaction() as db:
                records=list(db.scalars(select(s.Bar).where(s.Bar.instrument_id==ident,
                    s.Bar.timeframe==frame).order_by(s.Bar.start)))
                # Consecutive M15 members exercise both target open and close.
                # Daily indices straddle NY17/UTC0 week and month first members.
                indices=[len(records)//2-1,len(records)//2] if frame=='M15' else [20,22,23,30,31,35]
                picks=[records[index] for index in indices]
                for row in picks:
                    old=dict(price_revision=row.revision, volume_revision=row.volume_revision)
                    candle=row.candle()
                    if not observation_only:
                        candle=replace(candle, open=candle.open+Decimal('.5'), high=candle.high+4,
                            low=candle.low-2, close=candle.close+1,
                            volume=None if ident=='SYNTH00' else candle.volume+7,
                            volume_complete=ident not in ('SYNTH00','SYNTH01'), volume_supplied=True)
                    changes=b.write_bars(db, ident, frame, [candle], observed_at=b.clock)
                    db.refresh(row)
                    if observation_only:
                        assert not changes.price and not changes.volume
                        assert (row.revision,row.volume_revision)==(old['price_revision'],old['volume_revision'])
                    else:
                        assert changes.price=={row.start}
                        assert row.revision==old['price_revision']+1
                        assert all(getattr(row,key)==getattr(candle,key) for key in
                            ('open','high','low','close','volume','volume_complete'))
                    assert row.observed_at==b.clock
                    changed.append(dict(instrument=ident, source=frame, start=row.start,
                        observation_only=observation_only, price_revision=row.revision,
                        volume_revision=row.volume_revision, observed_at=row.observed_at))
    return changed


def compare_csv(content, bars):
    rows=list(csv.DictReader(io.StringIO(content.decode('utf-8-sig'))))
    assert len(rows)==len(bars)
    for actual, bar in zip(rows,bars):
        assert int(actual['start_ms'])==bar['start'] and int(actual['end_ms'])==bar['end']
        for key in ('open','high','low','close'):
            assert Decimal(actual[key])==Decimal(bar[key]), key
        assert (Decimal(actual['volume']) if actual['volume'] else None)==(
            Decimal(bar['volume']) if bar['volume'] is not None else None)
        for key in ('complete','volume_complete'):
            assert actual[key]==str(bar[key]).lower()
        assert int(actual['revision'])==bar['revision']


async def phase(label, web, agent, agent_token):
    inputs=source_inputs()
    archived=json.dumps(inputs,sort_keys=True).encode()
    (ROOT/(label+'-sources.json.gz')).write_bytes(gzip.compress(archived,mtime=0))
    snapshots=full_snapshots()
    cases=[]
    for ident, data in inputs.items():
        for frame in FRAMES:
            oracle=expected(data['frames']['M15' if frame=='M30' else 'D1'],frame,
                data['meta'], b.START, b.NOW-5000, b.clock)
            actual=[row['payload'] for row in snapshots[ident+'/'+frame]['rows']]
            if actual!=oracle:
                (ROOT/(label+'-mismatch.json')).write_text(json.dumps(dict(instrument=ident,
                    frame=frame, actual=actual, expected=oracle),indent=2)+'\n')
                raise AssertionError((label,ident,frame,'independent high-period oracle mismatch'))
            assert oracle, (ident,frame,'nonempty oracle required')
            publication=snapshots[ident+'/'+frame]['publication']
            assert publication['complete_count']==sum(row['complete'] for row in oracle)
            assert publication['start']<=oracle[0]['start'] and publication['end']==b.NOW-5000
            pages=0
            cursor=b.clock+1
            read=[]
            while True:
                wanted=[row for row in oracle if row['start']<cursor][-2000:]
                args=dict(instrument=ident,timeframe=frame,published=True,
                    dataset_start=b.START,before=cursor,limit=2000)
                response=await web.post('/api/charts/data',json=args)
                assert response.status_code==200, ('chart',response.status_code)
                page=response.json()
                assert page['bars']==wanted
                assert page['basis']==data['meta']['basis'] and page['calendar']==data['meta']['calendar']
                exported=await web.post('/api/charts/export',json=dict(instrument=ident,
                    timeframe=frame,published=True,start=wanted[0]['start'],
                    end=min(cursor,publication['end'])))
                assert exported.status_code==200, ('export',exported.status_code)
                compare_csv(exported.content,wanted)
                rpc=await agent.post('/mcp',headers={'Authorization':'Bearer '+agent_token,
                    'Accept':'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25'},
                    json=dict(jsonrpc='2.0',id=pages+1,method='tools/call',params=dict(
                        name='market_get_bars',arguments=args)))
                assert rpc.status_code==200, ('mcp',rpc.status_code)
                result=rpc.json()['result']
                assert not result.get('isError'), 'MCP returned business error'
                assert result['structuredContent']['page']['bars']==wanted
                assert result['structuredContent']['cursor_coordinate']=='utc_ms'
                read=wanted+read
                pages+=1
                if not page['has_more']:
                    break
                assert pages<4, 'Unexpected pagination loop'
                cursor=wanted[0]['start']
            assert read==oracle
            with s.transaction() as db:
                config=AlertConfig.model_validate(dict(name='Issue13 oracle',instrument=ident,
                    source=data['meta']['source'],timeframe=frame,published=True,
                    calculation_origin=b.START,condition=dict(relation='cross_up',
                        right=dict(kind='constant',value=100000)),notify_web=False,notify_ntfy=False))
                version=SimpleNamespace(dataset_id=None,market_identity=data['meta'])
                alert_rows,_=stored_rows(db,version,config,b.clock)
            assert [{key:row[key] for key in oracle[0]} for row in alert_rows]==oracle
            cases.append(dict(instrument=ident,calendar=data['meta']['calendar'],timeframe=frame,
                rows=len(oracle),complete_rows=sum(row['complete'] for row in oracle),
                unknown_volume_rows=sum(row['volume'] is None for row in oracle),pages=pages,
                expected_sha256=sha(oracle),actual_sha256=sha(actual),
                chart_csv_mcp_alert_read_equal=True))
    report=dict(label=label,source_archive_sha256=hashlib.sha256(archived).hexdigest(),
        snapshot_sha256=sha(snapshots),cases=cases)
    (ROOT/(label+'.json')).write_text(json.dumps(report,indent=2)+'\n')
    print(label+': 30 independent oracle cases and all authenticated consumers passed',flush=True)
    return report


async def main():
    ROOT.mkdir(exist_ok=True)
    if any(ROOT.glob('*-sources.json.gz')) or (ROOT/'result.json').exists():
        raise SystemExit('High-period evidence exists; no overwrite or automatic retry')
    b.reset()
    bar_batch.now_ms=lambda:b.clock
    with s.transaction() as db:
        for ident in b.IDENTITIES:
            m.join(db,db.get(s.Instrument,ident),b.START,b.NOW)
    publication_passes()
    session,csrf=secrets.token_urlsafe(32),secrets.token_urlsafe(24)
    session_hash=digest(session)
    expires=int(time.time()*1000)+600000
    with s.transaction() as db:
        db.add(s.LoginSession(token_hash=session_hash,csrf=csrf,expires=expires))
    agent_token=issue('issue13-high-period',['market:read'],expires)
    settings.mcp_calls_per_minute=600
    server,endpoint,adapter=create_server()
    protocol=FastAPI()
    protocol.add_route('/mcp',endpoint,methods=['GET','POST','DELETE','OPTIONS'])
    reports=[]
    try:
        async with server.session_manager.run(), httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),base_url='http://127.0.0.1:8000',
            cookies={'session':session},headers={'x-csrf-token':csrf}) as web, httpx.AsyncClient(
            transport=httpx.ASGITransport(app=protocol),base_url='http://127.0.0.1:8000') as agent:
            reports.append(await phase('initial',web,agent,agent_token))
            b.clock=b.NOW+1000
            changes=mutate()
            publication_passes()
            reports.append(await phase('revised',web,agent,agent_token))
            b.clock=b.NOW+2000
            observations=mutate(observation_only=True)
            publication_passes()
            reports.append(await phase('observation',web,agent,agent_token))
            duplicate=mutate(observation_only=True)
            publication_passes()
            reports.append(await phase('duplicate',web,agent,agent_token))
            assert reports[-1]['snapshot_sha256']==reports[-2]['snapshot_sha256'], 'Duplicate snapshot was not idempotent'
    finally:
        await adapter.close()
        with s.transaction() as db:
            db.execute(delete(s.LoginSession).where(s.LoginSession.token_hash==session_hash))
            db.execute(delete(s.AgentCredential).where(s.AgentCredential.token_hash==digest(agent_token)))
    report=dict(outcome='passed',scope='Independent M15/D1 high-period fold, PG publication and authenticated ASGI chart/CSV/MCP SDK; alert stored_rows',
        phases=reports,source_changes=changes,observations=observations,duplicate_inputs=duplicate,
        identity_count=10,periods=list(FRAMES),case_count=sum(len(r['cases']) for r in reports),
        clock='Fixed fixture clock + explicit 1s/2s observations; same floor-minute coverage cutoff',
        limitations=['M15/D1 are input records; not an oracle for M1->M15/D1 generation',
            'August/September fixture includes NY17/UTC0 but not DST transition or holiday corrections',
            'No product provider lifespan, network listener, browser, evaluate/trigger/notification or SLA measurement',
            'No coverage retraction, concurrent g+1, crash/restart, migration or rollback',
            'MCP protocol/SDK/auth/quota exercised in process; quota set to 600/minute only for this probe'],
        source_sha256={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in
            [Path(__file__),Path(__file__).with_name('high_period_oracle.py'),
                Path('backend/alerts/managed_dataset.py'),Path('backend/alerts/chart_data.py'),
                Path('backend/alerts/chart_alert_worker.py'),Path('backend/alerts/bar_batch.py')]})
    (ROOT/'result.json').write_text(json.dumps(report,indent=2)+'\n')
    print('HIGH PERIOD COMPLETE: 120 independent cases; duplicate full snapshot idempotent',flush=True)


if __name__=='__main__':
    asyncio.run(main())
