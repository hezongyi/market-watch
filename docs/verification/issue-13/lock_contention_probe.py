"""Observe a real publisher blocked by an independent PG row-lock holder.

Synthetic isolated fixture only. No product changes or provider/notification I/O.
This deliberately injected contention is not an estimate of production lock cost.
"""
import hashlib
import json
import threading
import time
from pathlib import Path

from sqlalchemy import create_engine, event, select, text
from sqlalchemy.pool import NullPool

import pg_baseline as b
from supplemental_probe import fingerprint

s, m = b.s, b.m
ROOT = Path('/results/lock-contention')


def main():
    ROOT.mkdir(exist_ok=True)
    if (ROOT/'result.json').exists():
        raise SystemExit('Existing lock evidence must be archived before rerun')
    b.reset()
    m._PUBLISH_CURSOR = None
    before = fingerprint()
    begun = time.monotonic()
    turns = []

    def turn(label):
        started = time.monotonic()
        claim = m.publish_once()
        result = dict(label=label, target=m._PUBLISH_CURSOR, claim=claim,
                      start_seconds=started-begun,
                      end_seconds=time.monotonic()-begun,
                      duration_seconds=time.monotonic()-started)
        turns.append(result)
        return result

    control = turn('unlocked control')
    locked_identity = control['target'][0]
    m._PUBLISH_CURSOR = None
    ready, done = threading.Event(), threading.Event()
    worker_thread_id = None
    worker_pid = None
    errors = []
    # The lock holder and observer represent external clients; they must not
    # consume the application's small pool or manufacture a pool-exhaustion bug.
    external = create_engine(s.engine.url, poolclass=NullPool,
        connect_args={'application_name': 'issue13_external_lock_probe'})

    def configure(session, transaction, conn):
        nonlocal worker_pid
        if threading.get_ident() == worker_thread_id:
            conn.execute(text("SET LOCAL statement_timeout='15s'"))
            worker_pid = conn.scalar(text('SELECT pg_backend_pid()'))
            ready.set()

    def publish():
        nonlocal worker_thread_id
        worker_thread_id = threading.get_ident()
        try:
            turn('external instrument lock')
        except Exception as error:
            errors.append(type(error).__name__)
        finally:
            done.set()

    event.listen(s.Session.class_, 'after_begin', configure)
    samples = []
    try:
        with external.connect() as holder:
            tx = holder.begin()
            try:
                holder.execute(text("SET LOCAL statement_timeout='15s'"))
                holder_pid = holder.scalar(text('SELECT pg_backend_pid()'))
                holder.execute(select(s.Instrument.id).where(
                    s.Instrument.id == locked_identity).with_for_update()).one()
                acquired = time.monotonic()-begun
                worker = threading.Thread(target=publish, name='actual-publisher')
                worker.start()
                assert ready.wait(5), 'Publisher failed to acquire connection'
                # Read committed snapshots for another identity while the actual
                # sequential publisher is waiting. This is a PG read, not HTTP.
                read_started = time.monotonic()
                with s.transaction() as db:
                    inst = db.get(s.Instrument, 'EURUSD')
                    rows = m.read_rows(db, inst, 'M1', b.NOW, 10)
                read_duration = time.monotonic()-read_started
                assert len(rows) == 10
                read_hash = hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest()
                with external.connect().execution_options(isolation_level='AUTOCOMMIT') as observer:
                    observer.execute(text("SET statement_timeout='2s'"))
                    deadline = time.monotonic()+3
                    while time.monotonic() < deadline:
                        activity = [dict(row) for row in observer.execute(text('''
                            SELECT pid, state, wait_event_type, wait_event,
                                   pg_blocking_pids(pid) AS blocking_pids
                            FROM pg_stat_activity
                            WHERE pid IN (:worker, :holder)
                        '''), dict(worker=worker_pid, holder=holder_pid)).mappings()]
                        samples.append(dict(at_seconds=time.monotonic()-begun,
                                            publisher_done=done.is_set(), activity=activity))
                        time.sleep(.1)
                assert not done.is_set(), 'Publisher did not wait for instrument lock'
            finally:
                tx.rollback()
                released = time.monotonic()-begun
            worker.join(timeout=20)
            assert not worker.is_alive(), 'Publisher failed to recover after lock release'
    finally:
        event.remove(s.Session.class_, 'after_begin', configure)
        external.dispose()
    assert not errors, errors
    blocked = turns[-1]
    assert blocked['target'] == control['target']
    evidence = [sample for sample in samples if any(
        row['pid'] == worker_pid and row['wait_event_type'] == 'Lock'
        and holder_pid in row['blocking_pids'] for row in sample['activity'])]
    assert len(evidence) >= 2, 'No repeated PG blocker evidence'
    assert blocked['end_seconds'] >= released
    # Resume the real cursor, without skipping other frames, until EURUSD gets
    # its normal turn. No retries or alternative publisher are introduced.
    for _ in range(len(m.FRAMES)):
        result = turn('normal rotation after release')
        if result['target'][0] != locked_identity:
            break
    assert result['target'][0] == 'EURUSD'
    after = fingerprint()
    assert before['sha256'] == after['sha256'], 'No-input published payload changed'
    visible = lambda fp: [{k:v for k,v in row.items() if k!='updated_at'} for row in fp['publications']]
    assert visible(before) == visible(after), 'No-input visible publication changed'
    report = dict(outcome='passed', scope='One synthetic instrument-row lock, real publish_once, fixed fixture clock',
        locked_identity=locked_identity, holder_pid=holder_pid, worker_pid=worker_pid,
        acquired_seconds=acquired, released_seconds=released,
        lock_hold_seconds=released-acquired, control=control, blocked=blocked,
        lock_wait_samples=len(evidence), samples=samples, turns=turns,
        other_identity=dict(identity='EURUSD', pg_read_seconds=read_duration,
            row_count=len(rows), payload_sha256=read_hash,
            first_publisher_turn_seconds=result['start_seconds'],
            first_publisher_completion_seconds=result['end_seconds']),
        full_bar_sha256=before['sha256'], full_bar_rows=sum(before['counts'].values()),
        visible_metadata_unchanged=True,
        source_sha256={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in
            [Path(__file__), Path('backend/alerts/managed_dataset.py'),
             Path('docs/verification/issue-13/pg_baseline.py')]},
        limitations=['Single forced 3-second lock; not natural contention frequency or production cost',
            'Read checks PG snapshot only; no HTTP/API/alert/provider/browser workload',
            'Fixed-clock idle payload stability; no concurrent source revisions or new generations',
            'Healthy target latency includes normal nine-period rotation and host scheduling'])
    (ROOT/'result.json').write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(dict(outcome=report['outcome'], lock_hold_seconds=report['lock_hold_seconds'],
        blocked_seconds=blocked['duration_seconds'], lock_wait_samples=len(evidence),
        other_identity_pg_read_seconds=read_duration,
        healthy_publish_completed_seconds=result['end_seconds'])), flush=True)


if __name__ == '__main__':
    main()
