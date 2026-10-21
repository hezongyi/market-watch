"""Read/write compatibility with an explicit baseline source artifact on isolated PG.

Requires TEST_POSTGRES_URL pointing to the issue89 preview, supplied privately by
the caller. Uses a new disposable schema, never clears the preview's public data.
"""

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tarfile
import tempfile
import uuid
from pathlib import Path

from sqlalchemy import create_engine, text

# Separate interpreters prevent current modules leaking into the rollback read.
PROBE = r'''
import hashlib,json,os
from sqlalchemy import create_engine,select
from sqlalchemy.orm import sessionmaker
from alerts import storage,provider_cache as cache,provider_chart as upstream
from alerts.chart_api import DataQuery
from test_provider_cache import META,page,seed
from test_provider_indicator_inputs import SPEC,stable_indicators
engine=create_engine(os.environ['TEST_POSTGRES_URL'],connect_args={
    'options':'-csearch_path='+os.environ['ISSUE89_SCHEMA']})
storage.Session=sessionmaker(engine,expire_on_commit=False)
upstream.metadata=lambda _:META
state_path=os.environ['ISSUE89_STATE']
def read(**kw):
    return cache.data(DataQuery(instrument=META['id'],series_kind='provider',
        timeframe='M1',before=1000000,limit=200,**kw))
def digest(result):
    return hashlib.sha256(json.dumps([result['bars'],stable_indicators(result)],
        sort_keys=True).encode()).hexdigest()
mode=os.environ['ISSUE89_PHASE']
if mode=='current-write':
    storage.Base.metadata.create_all(engine)
    payload=page(0,1000000,boundary=True)
    for bar in payload['bars']:
        bar.update(source_confirmed=True,coverage_complete=True,volume='7',volume_complete=True)
    key=seed(META,'M1',1000000,payload)
    price=read();result=read(indicators=[SPEC],provider_snapshot_id=price['provider_snapshot_id'])
    state={'key':key,'token':price['provider_snapshot_id'],'digest':digest(result)}
    json.dump(state,open(state_path,'w'))
elif mode=='baseline-read-write':
    state=json.load(open(state_path))
    result=read(indicators=[SPEC],provider_snapshot_id=state['token'])
    assert digest(result)==state['digest'],'old source must read new credential and values'
    with storage.transaction() as db:
        dataset=db.get(storage.ProviderDataset,state['key'])
        epoch=dataset.metadata_json['indicator_history_epoch']
        bars=[dict(row.payload) for row in db.scalars(select(storage.ProviderBar).where(
            storage.ProviderBar.dataset_id==state['key'],storage.ProviderBar.start>=998000))]
    for bar in bars:
        bar.pop('source_confirmed',None);bar.pop('coverage_complete',None)
    seed(META,'M1',1000000,{'bars':bars,'history_boundary':False})
    with storage.transaction() as db:
        after=db.get(storage.ProviderDataset,state['key']).metadata_json['indicator_history_epoch']
    assert after!=epoch,'baseline retains its documented false-invalidation regression'
    price=read();result=read(indicators=[SPEC],provider_snapshot_id=price['provider_snapshot_id'])
    state.update(token=price['provider_snapshot_id'],digest=digest(result),epoch=after)
    json.dump(state,open(state_path,'w'))
else:
    state=json.load(open(state_path))
    before=read(indicators=[SPEC],provider_snapshot_id=state['token'])
    assert digest(before)==state['digest']
    with storage.transaction() as db:
        bars=[dict(row.payload) for row in db.scalars(select(storage.ProviderBar).where(
            storage.ProviderBar.dataset_id==state['key'],storage.ProviderBar.start>=998000))]
    for bar in bars:bar.update(source_confirmed=True,coverage_complete=True)
    assert seed(META,'M1',1000000,{'bars':bars,'history_boundary':False})==state['key']
    with storage.transaction() as db:
        assert db.get(storage.ProviderDataset,state['key']).metadata_json['indicator_history_epoch']==state['epoch']
        assert 'source_confirmed' not in db.get(storage.ProviderBar,(state['key'],998000)).payload
    assert digest(read(indicators=[SPEC],provider_snapshot_id=state['token']))==state['digest']
print(json.dumps({'phase':mode,'passed':True}))
engine.dispose()
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', required=True, help='Exact baseline commit or tag to verify')
    args = parser.parse_args()
    if os.getenv('ISSUE89_TASK_PG') != 'mw-issue89-20261021':
        raise SystemExit('Requires explicit task-owned PostgreSQL environment')
    root = Path(__file__).resolve().parents[1]
    baseline_commit = subprocess.check_output(
        ['git', 'rev-parse', '--verify', '--end-of-options', args.baseline+'^{commit}'],
        cwd=root, text=True).strip()
    archive = subprocess.check_output(['git', 'archive', baseline_commit], cwd=root)
    schema = 'rollback89_' + uuid.uuid4().hex
    admin = create_engine(os.environ['TEST_POSTGRES_URL'])
    with admin.begin() as db:
        db.execute(text(f'CREATE SCHEMA {schema}'))
    try:
        with tempfile.TemporaryDirectory(prefix='issue89-rollback-') as folder:
            path = Path(folder)
            artifact = path / 'baseline.tar'
            artifact.write_bytes(archive)
            baseline = path / 'baseline'
            with tarfile.open(artifact) as bundle:
                bundle.extractall(baseline, filter='data')
            assert (root / 'requirements.lock').read_bytes() == (baseline / 'requirements.lock').read_bytes()
            for phase, source in [('current-write', root), ('baseline-read-write', baseline),
                                  ('current-read-old-write', root)]:
                environment = {**os.environ, 'ISSUE89_SCHEMA': schema,
                    'ISSUE89_STATE': str(path / 'state.json'), 'ISSUE89_PHASE': phase,
                    'PYTHONPATH': os.pathsep.join(str(source / p) for p in ['backend', 'backend/tests'])}
                subprocess.run([sys.executable, '-c', PROBE], cwd=source, env=environment, check=True)
        print(json.dumps({'baseline': baseline_commit, 'artifact_sha256': hashlib.sha256(archive).hexdigest(),
                          'locked_dependencies_unchanged': True, 'schema_cleared_between_phases': False,
                          'passed': True}))
    finally:
        with admin.begin() as db:
            db.execute(text(f'DROP SCHEMA {schema} CASCADE'))
        admin.dispose()


if __name__ == '__main__':
    main()
