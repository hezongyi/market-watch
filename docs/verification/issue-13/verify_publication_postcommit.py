"""Kill a committed publisher and verify durable recovery without its notification.

Run only after primary measurement and precommit/rollback checks have stopped.
The product remains the immutable candidate; this separate probe is mounted RO.
"""

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

from alerts import managed_dataset as managed
from alerts import market
from alerts import storage as s
from sqlalchemy import create_engine, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker


def main():
    url = make_url(os.environ['ALERTS_DATABASE_URL'])
    if (url.host, url.database, url.username) != ('postgres', 'issue13', 'issue13'):
        raise SystemExit('Only isolated Ubuntu task Compose database accepted')
    schema = 'publication_postcommit_' + uuid.uuid4().hex
    admin = create_engine(url, pool_size=1, max_overflow=0)
    with admin.begin() as conn:
        conn.execute(text(f'CREATE SCHEMA {schema}'))
    scoped = url.update_query_dict({'options': f'-csearch_path={schema}'})
    engine = create_engine(scoped, pool_size=1, max_overflow=0)
    factory = sessionmaker(engine, expire_on_commit=False)
    previous = s.Session
    s.Session = factory
    start = 1790553600000
    now = start + 30 * 60000 + 5000
    managed.now_ms = s.now_ms = lambda: now
    proc = None
    try:
        s.bootstrap(engine)
        with factory.begin() as db:
            inst = db.get(s.Instrument, 'BTCUSDT')
            managed.join(db, inst, start, now)
            market.ingest(db, inst, {'rows': [dict(timestamp=start + i * 60000,
                open=10, high=11, low=9, close=10) for i in range(30)]}, received_at=now)
        for _ in range(60):
            managed.publish_once()

        def snapshot():
            with factory.begin() as db:
                row = db.get(s.ChartPublishedBar, ('BTCUSDT', 'M1', start + 29 * 60000))
                pub = db.get(s.ChartPublication, ('BTCUSDT', 'M1'))
                state = db.get(s.ChartPublicationState, ('BTCUSDT', 'M1'))
                jobs = list(db.scalars(select(s.ChartPublicationJob).where(
                    s.ChartPublicationJob.instrument_id == 'BTCUSDT',
                    s.ChartPublicationJob.timeframe == 'M1')))
                return dict(payload=row.payload, row_revision=row.revision,
                    complete_count=pub.complete_count, publication_revision=pub.revision,
                    requested=state.requested, processed=state.processed, pending_jobs=len(jobs))

        initial = snapshot()
        assert initial['complete_count'] == 30
        now += 1000
        with factory.begin() as db:
            market.ingest(db, db.get(s.Instrument, 'BTCUSDT'), {'rows': [dict(
                timestamp=start + 29 * 60000, open=10, high=12, low=9, close=11)]},
                received_at=now)
        pending = snapshot()
        assert pending['requested'] > pending['processed']
        env = {**os.environ, 'ALERTS_DATABASE_URL': scoped.render_as_string(hide_password=False)}
        with tempfile.TemporaryDirectory(prefix='issue13-postcommit-') as temp:
            marker = Path(temp) / 'committed'
            child = '''
import time
from pathlib import Path
from alerts import managed_dataset as m, storage as s
m.now_ms=s.now_ms=lambda:NOW
for _ in range(60):
    m.publish_once()
    with s.transaction() as db:
        state=db.get(s.ChartPublicationState,('BTCUSDT','M1'))
        row=db.get(s.ChartPublishedBar,('BTCUSDT','M1',START+29*60000))
        complete=state.requested==state.processed and row.payload['observed_at']==NOW
    if complete:
        Path(MARKER).write_text('committed, verified from a new transaction')
        while True:time.sleep(1)
raise RuntimeError('No committed M1 snapshot reached')
'''.replace('NOW', str(now)).replace('START', str(start)).replace('MARKER', repr(str(marker)))
            proc = subprocess.Popen([sys.executable, '-c', child], env=env,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            deadline = time.monotonic() + 30
            while not marker.exists():
                if proc.poll() is not None:
                    raise RuntimeError('Publisher exited before postcommit marker')
                if time.monotonic() >= deadline:
                    raise RuntimeError('Publisher did not reach postcommit boundary')
                time.sleep(.05)
            committed = snapshot()
            assert committed['requested'] == committed['processed']
            assert committed['complete_count'] == 30 and committed['pending_jobs'] == 0
            assert committed['payload']['close'] != initial['payload']['close']
            assert committed['payload']['observed_at'] == now
            assert committed['row_revision'] == initial['row_revision'] + 1
            proc.kill()
            proc.wait(timeout=10)
            assert proc.returncode == -9
        assert snapshot() == committed, 'Postcommit kill changed durable snapshot'

        # The input notification was emitted while no listener existed. A newly
        # registered listener has no historical hint; durable state must suffice.
        now += 1000
        with factory.begin() as db:
            market.ingest(db, db.get(s.Instrument, 'BTCUSDT'), {'rows': [dict(
                timestamp=start + 29 * 60000, open=10, high=12, low=9, close=11)]},
                received_at=now)
        offline_pending = snapshot()
        assert offline_pending['requested'] > offline_pending['processed']
        resumed_marker = Path('/results') / ('postcommit-restart-' + uuid.uuid4().hex + '.json')
        restart = '''
import json
from pathlib import Path
from alerts import managed_dataset as m, storage as s
from alerts.publication_wakeup import PublicationWakeup
m.now_ms=s.now_ms=lambda:NOW
with PublicationWakeup() as wake:
    assert wake.connection is not None
    assert wake.wait(.05)=='timer', 'An old notification must not be replayed'
    for _ in range(60):
        wake.prepare()
        m.publish_once()
    with s.transaction() as db:
        row=db.get(s.ChartPublishedBar,('BTCUSDT','M1',START+29*60000))
        state=db.get(s.ChartPublicationState,('BTCUSDT','M1'))
        assert row.payload['observed_at']==NOW and state.requested==state.processed
    Path(MARKER).write_text(json.dumps({'old_hint_absent':True,'durable_input_resumed':True}))
'''.replace('NOW', str(now)).replace('START', str(start)).replace('MARKER', repr(str(resumed_marker)))
        result = subprocess.run([sys.executable, '-c', restart], env=env,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
        assert result.returncode == 0, 'Fresh listener/process could not resume durable work'
        restart_facts = json.loads(resumed_marker.read_text())
        resumed_marker.unlink()
        resumed = snapshot()
        assert resumed['payload']['observed_at'] == now and resumed['complete_count'] == 30
        assert resumed['requested'] == resumed['processed'] and resumed['pending_jobs'] == 0
        assert resumed['row_revision'] == committed['row_revision'] + 1
        assert {k: v for k, v in resumed['payload'].items() if k != 'observed_at'} == {
            k: v for k, v in committed['payload'].items() if k != 'observed_at'}

        # Restart again with no input; the acknowledged snapshot must be stable.
        repeat = '''
from alerts import managed_dataset as m, storage as s
m.now_ms=s.now_ms=lambda:NOW
for _ in range(60):m.publish_once()
'''.replace('NOW', str(now))
        result = subprocess.run([sys.executable, '-c', repeat], env=env,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
        assert result.returncode == 0 and snapshot() == resumed
        report = dict(environment='Ubuntu isolated unique PostgreSQL schema',
            source_commit=os.environ['ISSUE13_PRODUCT_COMMIT'],
            executed_probe_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            postcommit_process_killed=True, kill_returncode=-9,
            committed_snapshot_preserved=True, notification_absent_restart=restart_facts,
            repeated_restart_snapshot_count_revision_stable=True,
            initial=initial, committed=committed, resumed=resumed,
            scope='Postcommit SIGKILL, offline committed input without retained hint, fresh-process durable recovery and idempotent restart; no production writes')
        with (Path('/results') / 'publication-postcommit.json').open('x') as output:
            json.dump(report, output, indent=2)
            output.write('\n')
        print('Postcommit kill, absent notification, durable recovery and stable repeat passed', flush=True)
    finally:
        if proc is not None and proc.poll() is None:
            proc.kill()
            proc.wait(timeout=10)
        s.Session = previous
        engine.dispose()
        with admin.begin() as conn:
            conn.execute(text(f'DROP SCHEMA {schema} CASCADE'))
        admin.dispose()


if __name__ == '__main__':
    main()
