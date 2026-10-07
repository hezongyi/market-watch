"""Sustained 90-target rotation with real identity lock and one rolled-back copy.

The canonical full-size fixture is reused only after every preceding validation
has stopped. Input, publishing and aggregation use the immutable r5 product.
"""

import hashlib
import json
import os
import sys
import threading
import time
from pathlib import Path

from sqlalchemy import select, text

sys.path.insert(0, '/workspace/docs/verification/issue-13')
import pg_baseline as b
from alerts.publication_schedule import RULES, request
from alerts.publication_wakeup import PublicationWakeup

s, m = b.s, b.m


def main():
    target = Path('/results/rotation-faults.json')
    assert not target.exists(), 'Preserve previous evidence'
    b.reset()
    begun = time.monotonic()
    def clock():
        return b.NOW + int((time.monotonic() - begun) * 1000)
    m.now_ms = s.now_ms = clock

    def fault_snapshot(db):
        row = db.get(s.ChartPublishedBar, ('EURUSD', 'M1', b.NOW - 5000 - b.MINUTE))
        pub = db.get(s.ChartPublication, ('EURUSD', 'M1'))
        return dict(payload=row.payload, row_revision=row.revision,
                    count=pub.complete_count, publication_revision=pub.revision)

    with s.transaction() as db:
        fault_before = fault_snapshot(db)
        for ident in b.IDENTITIES:
            db.scalar(select(s.Instrument).where(s.Instrument.id == ident).with_for_update())
            request(db, ident, reason=RULES)
        for ident in ('SYNTH00', 'SYNTH01'):
            m.join(db, db.get(s.Instrument, ident), b.START, b.NOW)
        row = db.scalar(select(s.Bar).where(s.Bar.instrument_id == 'EURUSD',
                        s.Bar.timeframe == 'M1').order_by(s.Bar.start.desc()).limit(1))
        fault_observed = clock()
        assert fault_observed > fault_before['payload']['observed_at']
        b.write_bars(db, 'EURUSD', 'M1', [row.candle()], observed_at=fault_observed)
    ready_at = time.monotonic()
    expected = {(ident, frame) for ident in b.IDENTITIES for frame in m.FRAMES}
    assert len(expected) == 90
    last_service = {key: ready_at for key in expected}
    counts = {key: 0 for key in expected}
    first = {}
    turns, failures, lock_facts, lock_errors = [], [], {}, []
    locked, release = threading.Event(), threading.Event()

    def lock_holder():
        try:
            with s.engine.begin() as conn:
                conn.execute(text("SELECT id FROM instruments WHERE id='BTCUSDT' FOR UPDATE"))
                lock_facts['acquired'] = time.monotonic() - ready_at
                locked.set()
                release.wait(10)
            lock_facts['released'] = time.monotonic() - ready_at
        except Exception as error:
            lock_errors.append(type(error).__name__)
            locked.set()

    holder = threading.Thread(target=lock_holder)
    holder.start()
    assert locked.wait(5) and not lock_errors
    original = m.publish_frame

    def publish(db, inst, plan, frame, stamp):
        result = original(db, inst, plan, frame, stamp)
        if (inst.id, frame) == ('EURUSD', 'M1') and not failures:
            db.flush()
            failures.append(dict(target=[inst.id, frame], at=time.monotonic() - ready_at,
                                 boundary='copied and flushed, before savepoint commit'))
            raise ValueError('Injected one-target publication copy failure')
        return result

    m.publish_frame = publish
    maximum = 0
    next_input = ready_at
    try:
        with PublicationWakeup(s.engine) as wake:
            while time.monotonic() - ready_at < 45:
                if time.monotonic() - ready_at >= 2:
                    release.set()
                # A different identity remains active while BTCUSDT is locked.
                if time.monotonic() >= next_input:
                    with s.transaction() as db:
                        db.scalar(select(s.Instrument).where(s.Instrument.id == 'XAUUSD').with_for_update())
                        row = db.scalar(select(s.Bar).where(s.Bar.instrument_id == 'XAUUSD',
                            s.Bar.timeframe == 'M1').order_by(s.Bar.start.desc()).limit(1))
                        b.write_bars(db, 'XAUUSD', 'M1', [row.candle()], observed_at=clock())
                    next_input = time.monotonic() + .5
                wake.prepare()
                with s.transaction() as db:
                    states = list(db.scalars(select(s.ChartPublicationState).where(
                        s.ChartPublicationState.requested > s.ChartPublicationState.processed)))
                    ready = {(r.instrument_id, r.timeframe) for r in states
                             if r.next_at is not None and r.next_at <= clock()}
                    delayed = [dict(target=[r.instrument_id, r.timeframe], next_at=r.next_at,
                                    attempts=r.attempts, reason=r.blocked_reason)
                               for r in states if r.attempts]
                for key in ready:
                    last_service.setdefault(key, time.monotonic())
                start = time.monotonic()
                aggregate, publication = b.cycle()
                done = time.monotonic()
                key = tuple(publication.selected_target) if publication.selected_target else None
                ages = {k: done - last_service[k] for k in ready}
                maximum = max(maximum, max(ages.values(), default=0))
                failed = publication.attempted and publication.blocked_reason == 'ValueError'
                if failed:
                    assert key == ('EURUSD', 'M1') and publication.runnable_remaining
                    assert b.wait_seconds(aggregate, publication) == .005
                    with s.transaction() as db:
                        state = db.get(s.ChartPublicationState, key)
                        assert state.attempts == 1 and state.next_at > clock()
                        assert fault_snapshot(db) == fault_before, 'Failed copy leaked visible changes'
                        failures[0].update(retry_at=state.next_at, requested=state.requested,
                                           processed=state.processed, snapshot_rollback_verified=True)
                        assert state.requested > state.processed
                if publication.task_progressed:
                    assert key in expected
                    first.setdefault(key, done - ready_at)
                    counts[key] += 1
                    last_service[key] = done
                    with s.transaction() as db:
                        request(db, key[0], frames=(key[1],), reason=RULES)
                turns.append(dict(at=done - ready_at, seconds=done - start,
                    target=key, progressed=publication.task_progressed, failed=failed,
                    aggregate=aggregate, runnable_remaining=publication.runnable_remaining,
                    ready_ages=[dict(target=k, seconds=v) for k, v in sorted(ages.items())],
                    delayed=delayed, requested_wait=b.wait_seconds(aggregate, publication)))
                wake.wait(b.wait_seconds(aggregate, publication))
    finally:
        m.publish_frame = original
        release.set()
        holder.join(timeout=5)
    assert not holder.is_alive() and not lock_errors
    with s.transaction() as db:
        states = list(db.scalars(select(s.ChartPublicationState)))
        terminal_ready = {(r.instrument_id, r.timeframe) for r in states
                          if r.requested > r.processed and r.next_at is not None and r.next_at <= clock()}
        outstanding_retries = [(r.instrument_id, r.timeframe) for r in states if r.attempts]
        fault_after = fault_snapshot(db)
    end = time.monotonic()
    terminal = [dict(target=k, seconds=end-last_service[k], right_censored=True)
                for k in sorted(terminal_ready)]
    maximum = max([maximum] + [r['seconds'] for r in terminal])
    missing = sorted(expected - first.keys())
    healthy_during_lock = [r for r in turns if r['progressed'] and
                          r['at'] < lock_facts['released'] and r['target'][0] != 'BTCUSDT']
    healthy_during_retry = [r for r in turns if r['progressed'] and failures and
                           failures[0]['at'] < r['at'] < failures[0]['at'] + 2 and
                           r['target'] != ('EURUSD', 'M1')]
    report = dict(source_commit=os.environ['ISSUE13_PRODUCT_COMMIT'],
        executed_probe_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        targets=90, duration=end-ready_at, turns=turns, missing=missing,
        first_service=[dict(target=k, seconds=v) for k, v in sorted(first.items())],
        rounds=[dict(target=k, count=v) for k, v in sorted(counts.items())],
        longest_target_wait=maximum, terminal_unserved_ages=terminal,
        failures=failures, outstanding_retries=outstanding_retries,
        lock=lock_facts, lock_errors=lock_errors,
        healthy_services_during_lock=len(healthy_during_lock),
        healthy_services_during_retry=len(healthy_during_retry),
        failed_input_observed_at=fault_observed, fault_before=fault_before, fault_after=fault_after,
        scope='45s sustained 90-target rotation, continuous observation, two large backfills, two-second external identity lock and one failed copy; locked age also conservatively counted, retry not ready before due')
    with target.open('x') as output:
        json.dump(report, output, indent=2)
        output.write('\n')
    assert not missing and min(counts.values()) >= 2
    assert maximum <= 10 and not outstanding_retries
    assert len(failures) == 1 and healthy_during_lock and healthy_during_retry
    assert fault_after['payload']['observed_at'] == fault_observed
    assert fault_after['count'] == fault_before['count']
    assert fault_after['row_revision'] == fault_before['row_revision'] + 1
    print('90-target fault/lock/retry rotation passed, longest wait:', maximum)


if __name__ == '__main__':
    main()
