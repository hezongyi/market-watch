"""Exercise the frozen v1.14.0 publisher against retained additive candidate schema."""

import json
import os
import subprocess
import sys
import uuid
from pathlib import Path

from alerts import managed_dataset as managed
from alerts import market
from alerts import storage as s
from alerts.chart_aggregation import aggregate_once
from alerts.publication_admin import prepare_rollback_page
from sqlalchemy import create_engine, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker


def main():
    url = make_url(os.environ['ALERTS_DATABASE_URL'])
    if (url.host, url.database, url.username) != ('postgres', 'issue13', 'issue13'):
        raise SystemExit('Only isolated Ubuntu task database accepted')
    schema = 'app_rollback_' + uuid.uuid4().hex
    admin = create_engine(url, pool_size=1, max_overflow=0)
    with admin.begin() as conn:
        conn.execute(text(f'CREATE SCHEMA {schema}'))
    scoped = url.update_query_dict({'options': f'-csearch_path={schema}'})
    engine = create_engine(scoped, pool_size=1, max_overflow=0)
    factory = sessionmaker(engine, expire_on_commit=False)
    previous = s.Session
    s.Session = factory
    start = 1790553600000
    clock = [start + 30 * 60000 + 5000]
    s.now_ms = lambda: clock[0]
    managed.now_ms = lambda: clock[0]
    try:
        s.bootstrap(engine)
        with factory.begin() as db:
            inst = db.get(s.Instrument, 'BTCUSDT')
            managed.join(db, inst, start, clock[0])
            market.ingest(db, inst, {'rows': [dict(timestamp=start + i * 60000,
                open=10, high=11, low=9, close=10) for i in range(30)]}, received_at=clock[0])
        for _ in range(60):
            aggregate_once()
            managed.publish_once()
        with factory.begin() as db:
            before = db.get(s.ChartPublishedBar, ('BTCUSDT', 'M1', start + 29 * 60000)).payload
        clock[0] += 1000
        with factory.begin() as db:
            market.ingest(db, db.get(s.Instrument, 'BTCUSDT'), {'rows': [dict(
                timestamp=start + 29 * 60000, open=10, high=11, low=9, close=10)]}, received_at=clock[0])
            db.execute(text('DELETE FROM chart_publication_jobs'))
            frames = list(db.scalars(select(s.ChartPublication.timeframe)))
        # New writers/publisher are stopped. Build old protocol jobs with
        # independent page transactions; retained state is not acknowledged.
        for frame in frames:
            after = -1
            while True:
                with factory.begin() as db:
                    result = prepare_rollback_page(db, db.get(s.Instrument, 'BTCUSDT'), frame, after=after, limit=5)
                after = result['after']
                if result['complete']:
                    break
        code = """
import json
from alerts import managed_dataset as m, storage as s
from alerts.chart_aggregation import aggregate_once
m.now_ms = s.now_ms = lambda: CLOCK
for _ in range(30):
    aggregate_once()
    m.publish_once()
with s.transaction() as db:
    row=db.get(s.ChartPublishedBar, ('BTCUSDT','M1',START+29*60000))
    assert row.payload['observed_at']==CLOCK
    assert m.status(db,db.get(s.Instrument,'BTCUSDT'),'M1')['complete_count']==30
    print(json.dumps({'old_binary':'131bf3c/v1.14.0','observed_at':row.payload['observed_at'],
                      'complete_count':30,'legacy_protocol_resumed':True}))
""".replace('CLOCK', str(clock[0])).replace('START', str(start))
        env = {**os.environ, 'ALERTS_DATABASE_URL': scoped.render_as_string(hide_password=False),
               'PYTHONPATH': '/oldsource/backend'}
        result = subprocess.run([sys.executable, '-c', code], cwd='/oldsource', env=env,
                                capture_output=True, text=True, timeout=60)
        if result.returncode:
            raise RuntimeError('Old application rollback failed; captured output withheld')
        old = json.loads(result.stdout.strip().splitlines()[-1])
        for _ in range(60):
            aggregate_once()
            managed.publish_once()
        with factory.begin() as db:
            after = db.get(s.ChartPublishedBar, ('BTCUSDT', 'M1', start + 29 * 60000)).payload
            assert after['observed_at'] == clock[0]
            assert {k: v for k, v in before.items() if k != 'observed_at'} == {
                k: v for k, v in after.items() if k != 'observed_at'}
            assert managed.status(db, db.get(s.Instrument, 'BTCUSDT'), 'M1')['complete_count'] == 30
        with (Path('/results') / 'application-rollback.json').open('x') as file:
            json.dump(dict(environment='Ubuntu mw-issue13-optimized unique PG schema', old_application=old,
                new_application_resumed=True, raw_proof_and_additive_schema_retained=True,
                scope='Real old/new publisher processes, no simultaneous owner or production deployment'), file, indent=2)
            file.write('\n')
        print('Old v1.14.0 publisher rollback and candidate resume passed', flush=True)
    finally:
        s.Session = previous
        engine.dispose()
        with admin.begin() as conn:
            conn.execute(text(f'DROP SCHEMA {schema} CASCADE'))
        admin.dispose()


if __name__ == '__main__':
    main()
