"""Committed task controls and real worker process loss over isolated PG."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

import pytest
from sqlalchemy import select
from alerts import history_artifacts as a, history_maintenance as maintenance
from alerts.storage import DatasetMaintenance, HistoryArtifact, HistoryArtifactBlock, HistoryRun, HistoryVersion
from test_history_artifacts import publish
from test_market_contracts import minute
from test_provider_postgres import provider_pg

pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"), reason="Isolated Ubuntu PostgreSQL required")

def snapshot(factory, ident):
    with factory() as db:
        return [(x.timeframe, x.cursor, x.status, x.count, x.accumulator, x.manifest)
            for x in db.scalars(select(HistoryArtifact).where(HistoryArtifact.version_id == ident).order_by(HistoryArtifact.timeframe))]

def test_pause_resume_cancel_restart_and_locked_queue_backpressure(provider_pg):
    factory, engine = provider_pg
    end = 12001 * 60000
    rows = tuple(minute(at) for at in range(0, end, 60000))
    ids = [publish(factory, end=end, rows=rows)[0] for _ in range(2)]
    with factory.begin() as db:
        for ident in ids:
            v = db.get(HistoryVersion, ident)
            if not db.get(DatasetMaintenance, v.dataset_id):
                db.add(DatasetMaintenance(dataset_id=v.dataset_id, target_start=0, next_at=0, timeframes=['M1','H1','MN']))
            db.add(HistoryRun(version_id=ident, dataset_id=v.dataset_id, request_id=ident,
                request_hash=ident, kind='recheck', refresh_start=0, refresh_end=end))
            a.request_artifacts(db, v, ['M1','H1','MN'])
    assert a.artifact_tick(ids[0])
    before = snapshot(factory, ids[0])
    with factory.begin() as db: maintenance.task_control(db, ids[0], 'pause')
    assert not a.artifact_tick(ids[0])
    assert snapshot(factory, ids[0]) == before
    with factory.begin() as db: maintenance.task_control(db, ids[0], 'resume')
    # An occupied row is skipped rather than creating an unbounded waiting turn.
    with factory.begin() as db:
        db.scalars(select(HistoryArtifact).where(HistoryArtifact.version_id==ids[0]).with_for_update()).all()
        started = time.monotonic()
        assert not a.artifact_tick(ids[0])
        assert time.monotonic()-started < 2
        assert a.artifact_tick(ids[1]), 'unrelated task receives service while first is locked'
    with engine.connect() as conn:
        schema = conn.exec_driver_sql('SELECT current_schema()').scalar()
    child = '''
import os
from sqlalchemy import create_engine,event
from sqlalchemy.orm import sessionmaker
from alerts import storage,history_artifacts
engine=create_engine(os.environ['TEST_POSTGRES_URL'],connect_args={'options':'-csearch_path='+os.environ['DERIVE_SCHEMA']})
storage.Session=sessionmaker(engine,expire_on_commit=False)
if os.environ['DERIVE_CRASH']=='1':
    event.listen(engine,'commit',lambda conn:os._exit(17))
assert history_artifacts.artifact_tick(os.environ['DERIVE_VERSION'])
engine.dispose()
'''
    env={**os.environ,'DERIVE_SCHEMA':schema,'DERIVE_VERSION':ids[0],
        'PYTHONPATH':str(Path(__file__).resolve().parents[1]),'DERIVE_CRASH':'1'}
    assert subprocess.run([sys.executable,'-c',child],env=env,timeout=30).returncode==17
    assert snapshot(factory,ids[0]) == before, 'process death before commit rolls back the complete page'
    env['DERIVE_CRASH']='0'
    assert subprocess.run([sys.executable,'-c',child],env=env,timeout=30).returncode==0
    assert snapshot(factory,ids[0]) != before, 'new process resumes durable accumulator/cursor'
    cancelled = snapshot(factory,ids[1])
    with factory.begin() as db: maintenance.task_control(db,ids[1],'cancel')
    assert not a.artifact_tick(ids[1])
    assert snapshot(factory,ids[1]) == cancelled
    with factory.begin() as db:
        with pytest.raises(ValueError,match='已取消'):maintenance.task_control(db,ids[1],'resume')
    while a.artifact_tick(ids[0]): pass
    with factory() as db:
        v=db.get(HistoryVersion,ids[0]);progress=a.derivation_progress(db,v)
        assert progress['published_periods']==3
        assert progress['processed_rows']==progress['total_rows']==12001*3
        for frame in ['M1','H1','MN']:
            actual=a.read_artifact(db,ids[0],frame,limit=20000)
            assert sum(r['observed_minutes'] for r in actual)==12001
            assert len({r['start'] for r in actual})==len(actual)
        blocks=db.scalars(select(HistoryArtifactBlock).join(HistoryArtifact).where(HistoryArtifact.version_id==ids[0])).all()
        assert len({(b.artifact_id,b.start) for b in blocks})==len(blocks)
