"""Kill actual publisher before commit, then restart against durable isolated PG state."""
import json
import os
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

from sqlalchemy import create_engine, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker

from alerts import managed_dataset as managed, market, storage as s


def main():
    url = make_url(os.environ['ALERTS_DATABASE_URL'])
    if (url.host,url.database,url.username) != ('postgres','issue13','issue13'):
        raise SystemExit('Only isolated Ubuntu task Compose database accepted')
    schema='publication_crash_'+uuid.uuid4().hex
    admin=create_engine(url,pool_size=1,max_overflow=0)
    with admin.begin() as conn:
        conn.execute(text(f'CREATE SCHEMA {schema}'))
    scoped=url.update_query_dict({'options':f'-csearch_path={schema}'})
    engine=create_engine(scoped,pool_size=1,max_overflow=0)
    factory=sessionmaker(engine,expire_on_commit=False)
    previous=s.Session
    s.Session=factory
    start=1790553600000
    now=start+30*60000+5000
    managed.now_ms=s.now_ms=lambda:now
    proc=None
    try:
        s.bootstrap(engine)
        with factory.begin() as db:
            inst=db.get(s.Instrument,'BTCUSDT')
            managed.join(db,inst,start,now)
            market.ingest(db,inst,{'rows':[dict(timestamp=start+i*60000,
                open=10,high=11,low=9,close=10) for i in range(30)]},received_at=now)
        for _ in range(60):
            managed.publish_once()
        def snapshot():
            with factory.begin() as db:
                row=db.get(s.ChartPublishedBar,('BTCUSDT','M1',start+29*60000))
                pub=db.get(s.ChartPublication,('BTCUSDT','M1'))
                state=db.get(s.ChartPublicationState,('BTCUSDT','M1'))
                return dict(payload=row.payload,row_revision=row.revision,
                    complete_count=pub.complete_count,publication_revision=pub.revision,
                    requested=state.requested,processed=state.processed)
        now+=1000
        with factory.begin() as db:
            market.ingest(db,db.get(s.Instrument,'BTCUSDT'),{'rows':[dict(timestamp=start+29*60000,
                open=10,high=11,low=9,close=10)]},received_at=now)
        before=snapshot()
        assert before['requested'] > before['processed']
        env={**os.environ,'ALERTS_DATABASE_URL':scoped.render_as_string(hide_password=False)}
        with tempfile.TemporaryDirectory(prefix='issue13-crash-') as temp:
            marker=Path(temp)/'flushed'
            code='''
import time
from pathlib import Path
from alerts import managed_dataset as m, storage as s
m.now_ms=s.now_ms=lambda:NOW
original=m.publish_frame
def publish(db,inst,plan,frame,stamp):
    result=original(db,inst,plan,frame,stamp)
    if frame=='M1':
        db.flush()
        Path(MARKER).write_text('flushed before commit')
        while True:time.sleep(1)
    return result
m.publish_frame=publish
for _ in range(30):m.publish_once()
'''.replace('NOW',str(now)).replace('MARKER',repr(str(marker)))
            proc=subprocess.Popen([sys.executable,'-c',code],env=env,
                stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            deadline=time.monotonic()+30
            while not marker.exists():
                if proc.poll() is not None:
                    raise RuntimeError('Publisher exited before injected precommit boundary')
                if time.monotonic()>deadline:
                    raise RuntimeError('Publisher did not reach precommit boundary')
                time.sleep(.05)
            assert snapshot()==before,'Uncommitted visible data leaked to another transaction'
            proc.kill()
            proc.wait(timeout=10)
            assert proc.returncode==-9
        assert snapshot()==before,'Killed publisher changed snapshot or acknowledged pending input'
        restart='''
from alerts import managed_dataset as m, storage as s
m.now_ms=s.now_ms=lambda:NOW
for _ in range(60):m.publish_once()
'''.replace('NOW',str(now))
        result=subprocess.run([sys.executable,'-c',restart],env=env,
            stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30)
        assert result.returncode==0
        final=snapshot()
        assert final['payload']['observed_at']==now and final['complete_count']==30
        assert final['row_revision']==before['row_revision']+1
        assert final['processed']==final['requested']
        assert {k:v for k,v in final['payload'].items() if k!='observed_at'}=={
            k:v for k,v in before['payload'].items() if k!='observed_at'}
        target=Path('/results')/'publication-crash.json'
        with target.open('x') as output:
            json.dump(dict(environment='Ubuntu isolated unique PostgreSQL schema',
                precommit_process_killed=True,kill_returncode=-9,
                uncommitted_visibility_unchanged=True,pending_generation_retained=True,
                actual_new_process_resumed=True,before=before,after=final,
                scope='Actual publisher process SIGKILL before transaction commit and fresh process resume; no production writes'),output,indent=2)
            output.write('\n')
        print('Actual precommit publisher kill and process restart passed',flush=True)
    finally:
        if proc is not None and proc.poll() is None:
            proc.kill()
            proc.wait(timeout=10)
        s.Session=previous
        engine.dispose()
        with admin.begin() as conn:
            conn.execute(text(f'DROP SCHEMA {schema} CASCADE'))
        admin.dispose()


if __name__=='__main__':
    main()
