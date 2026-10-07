"""Additional optimized candidate evidence, isolated PG only; never overwrite the frozen suite.

The fixture epoch advances with monotonic elapsed time. Provider I/O and alert
threads are absent. All ten identities receive a completed minute and a later
same-price observation while two identities also backfill historical pages.
"""
import argparse
import hashlib
import json
import math
import threading
import time
from collections import Counter
from pathlib import Path

from sqlalchemy import event, select, text

import pg_baseline as b

s, m = b.s, b.m
ROOT = Path('/results/supplemental')


def save(name, value):
    (ROOT / name).write_text(json.dumps(value, indent=2, default=str) + '\n')


def fingerprint():
    """Hash every persisted bar field, including payload and row revision."""
    digest = hashlib.sha256()
    counts = Counter()
    with s.engine.connect() as conn:
        rows = conn.execute(select(s.ChartPublishedBar.__table__).order_by(
            s.ChartPublishedBar.instrument_id, s.ChartPublishedBar.timeframe,
            s.ChartPublishedBar.start)).mappings()
        for row in rows:
            value = dict(row)
            digest.update((json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode())
            counts[value['instrument_id'] + '/' + value['timeframe']] += 1
        publications = [dict(r) for r in conn.execute(select(s.ChartPublication.__table__).order_by(
            s.ChartPublication.instrument_id, s.ChartPublication.timeframe)).mappings()]
    return dict(sha256=digest.hexdigest(), counts=dict(counts), publications=publications)


def inject(index):
    ident = b.IDENTITIES[index % len(b.IDENTITIES)]
    with s.transaction() as db:
        inst = db.get(s.Instrument, ident)
        bar = db.scalar(select(s.Bar).where(s.Bar.instrument_id == ident, s.Bar.timeframe == 'M1')
                        .order_by(s.Bar.start.desc()).limit(1))
        if index < len(b.IDENTITIES):
            # One contiguous minute. The caller waits until it has closed and
            # the five-second confirmation allowance has elapsed.
            assert bar.end + b.MINUTE <= b.clock - 5000
            raw = dict(timestamp=bar.end, open=str(bar.close), high=str(bar.close + 1),
                       low=str(bar.close - 1), close=str(bar.close), complete=True, volume=1)
            b.ingest(db, inst, dict(source=inst.source, basis=inst.basis, rows=[raw],
                coverage=[dict(start=bar.end, end=bar.end + b.MINUTE)]),
                received_at=b.clock, defer_aggregation=True)
            kind, start = 'new_bar', bar.end
        else:
            # Keep this input separate from the new minute so a later observation
            # cannot supersede an as-yet-unseen new-bar expected payload.
            bar = db.scalar(select(s.Bar).where(s.Bar.instrument_id == ident,
                s.Bar.timeframe == 'M1', s.Bar.start == b.NOW - 5000 - b.MINUTE))
            b.write_bars(db, ident, 'M1', [bar.candle()], observed_at=b.clock)
            kind, start = 'observation', bar.start
        # Independent expected M1 payload from persisted source fields, not the
        # publication read helper. Volume uses storage's canonical formatting.
        db.flush()
        row = db.scalar(select(s.Bar).where(s.Bar.instrument_id == ident,
            s.Bar.timeframe == 'M1', s.Bar.start == start))
        expected = {**s.candle_dict(row.candle()), 'observed_at': row.observed_at}
        assert expected['observed_at'] <= b.clock and expected['end'] <= b.clock - 5000
    return dict(instrument=ident, kind=kind, start=start, expected_payload=expected)


def matched(item):
    with s.transaction() as db:
        row = db.get(s.ChartPublishedBar, (item['instrument'], 'M1', item['start']))
        return row is not None and row.payload == item['expected_payload']


def quantiles(values):
    ordered = sorted(values)
    return {name: ordered[math.ceil(len(ordered) * q) - 1] if ordered else None
            for name, q in [('p50', .5), ('p95', .95), ('p99', .99)]}


def measure(scenario, seconds):
    target = ROOT / (scenario + '.json')
    if target.exists() or (ROOT / (scenario + '.jsonl')).exists():
        raise SystemExit('Supplemental evidence exists; deliberately archive before rerunning')
    b.reset()
    m._PUBLISH_CURSOR = None
    before = fingerprint()
    before_state = b.snapshot()
    assert not before_state['aggregation_jobs'] and not before_state['publication_jobs']
    if scenario == 'mixed':
        with s.transaction() as db:
            for ident in b.IDENTITIES[:2]:
                m.join(db, db.get(s.Instrument, ident), b.START, b.NOW)

    queries = Counter()
    scope = 'verification'
    main_thread = threading.get_ident()
    def count(conn, cursor, statement, *args):
        if scope != 'worker' or threading.get_ident() != main_thread:
            return
        queries['total'] += 1
        for token, label in [('FROM candles', 'source_reads'), ('FROM audit_events', 'audit_reads'),
                ('FROM market_data_coverage', 'coverage_reads'),
                ('UPDATE chart_publications', 'publication_updates'),
                ('INSERT INTO chart_published_bars', 'snapshot_insert_statements')]:
            if token in statement:
                queries[label] += 1

    # Sample concurrent waits through a separate connection. Zero samples with
    # wait_event_type=Lock cannot exclude waits shorter than the 500ms interval.
    stop = threading.Event()
    locks, sample_errors = [], []
    def lock_sampler():
        try:
            with s.engine.connect().execution_options(isolation_level='AUTOCOMMIT') as conn:
                conn.execute(text("SET statement_timeout='2s'"))
                while not stop.is_set():
                    rows = [dict(r) for r in conn.execute(text('''SELECT pid, state,
                        wait_event_type, wait_event, pg_blocking_pids(pid) AS blocking_pids
                        FROM pg_stat_activity WHERE datname=current_database()
                        AND pid<>pg_backend_pid() AND backend_type='client backend' ''')).mappings()]
                    locks.append(dict(at=time.monotonic() - begun, connections=rows))
                    stop.wait(.5)
        except Exception as error:
            sample_errors.append(type(error).__name__)

    with s.engine.begin() as conn:
        conn.execute(text('SELECT pg_stat_statements_reset()'))
    event.listen(s.engine, 'before_cursor_execute', count)
    cgroup_before = {name:(Path('/sys/fs/cgroup')/name).read_text()
        for name in ('cpu.stat','memory.current','memory.events') if (Path('/sys/fs/cgroup')/name).exists()}
    begun, cpu_begun = time.monotonic(), time.process_time()
    sampler = threading.Thread(target=lock_sampler, daemon=True)
    sampler.start()
    events, pending, fairness, turns = [], [], {}, []
    ready_since = {}
    sequence = 0
    try:
        from alerts.publication_wakeup import PublicationWakeup
        with PublicationWakeup(s.engine) as wakeup, (ROOT / (scenario + '.jsonl')).open('x') as output:
            while time.monotonic() - begun < seconds:
                wakeup.prepare()
                b.clock = b.NOW + int(1000 * (time.monotonic() - begun))
                if scenario == 'mixed' and sequence < 20 and time.monotonic() - begun >= 60 + sequence * 5:
                    scope = 'input'
                    item = inject(sequence)
                    item['committed_seconds'] = time.monotonic() - begun
                    pending.append(item)
                    sequence += 1
                scope = 'verification'
                with s.transaction() as db:
                    ready = set(db.execute(select(s.ChartPublicationState.instrument_id,
                        s.ChartPublicationState.timeframe).where(
                        s.ChartPublicationState.requested > s.ChartPublicationState.processed,
                        s.ChartPublicationState.next_at <= b.clock)).all())
                at = time.monotonic()
                ready_since = {key: ready_since.get(key, at) for key in ready}
                scope = 'worker'
                t = time.monotonic()
                aggregate, publish = b.cycle()
                elapsed = time.monotonic() - t
                scope = 'verification'
                at = time.monotonic() - begun
                cursor = getattr(publish,'selected_target',None) or (
                    m._PUBLISH_CURSOR if publish.task_progressed else None)
                turn = dict(at=at, seconds=elapsed, target=cursor,
                    target_wait=max((time.monotonic()-stamp for stamp in ready_since.values()), default=0),
                    ready_ages=[dict(target=list(key),seconds=time.monotonic()-stamp)
                        for key,stamp in sorted(ready_since.items())],
                    aggregate=aggregate, publish_claim=bool(publish), queries=dict(queries))
                if cursor:
                    fairness[cursor] = time.monotonic()
                    ready_since[cursor] = time.monotonic()
                turns.append(turn)
                output.write(json.dumps(turn) + '\n')
                output.flush()
                for item in pending[:]:
                    if matched(item):
                        events.append(dict(**item, visible_seconds=time.monotonic() - begun,
                            latency_seconds=time.monotonic() - begun - item['committed_seconds']))
                        pending.remove(item)
                wakeup.wait(b.wait_seconds(aggregate,publish),stop)
    finally:
        duration = time.monotonic() - begun
        cpu = time.process_time() - cpu_begun
        stop.set()
        sampler.join(timeout=5)
        event.remove(s.engine, 'before_cursor_execute', count)
    cgroup_after = {name:(Path('/sys/fs/cgroup')/name).read_text()
        for name in cgroup_before}
    assert not sampler.is_alive(), 'lock sampler did not stop'
    with s.transaction() as db:
        final_ready=set(db.execute(select(s.ChartPublicationState.instrument_id,
            s.ChartPublicationState.timeframe).where(
            s.ChartPublicationState.requested>s.ChartPublicationState.processed,
            s.ChartPublicationState.next_at<=b.clock)).all())
    ended=time.monotonic()
    unresolved=[dict(target=list(key),seconds=ended-ready_since.get(key,ended),right_censored=True)
        for key in sorted(final_ready)]
    after = fingerprint()
    after_state = b.snapshot()
    with s.engine.begin() as conn:
        statements = [dict(r) for r in conn.execute(text('''SELECT query,calls,total_exec_time,rows,
            shared_blks_hit,shared_blks_read,temp_blks_read,temp_blks_written
            FROM pg_stat_statements ORDER BY total_exec_time DESC''')).mappings()]
    save(scenario + '-sql.json', dict(statements=statements,
        note='Includes input, validation and 500ms wait sampler, not pure worker SQL'))
    save(scenario + '-locks.json', dict(samples=locks, errors=sample_errors, interval_seconds=.5))
    before_visible = [{k: v for k, v in row.items() if k != 'updated_at'} for row in before['publications']]
    after_visible = [{k: v for k, v in row.items() if k != 'updated_at'} for row in after['publications']]
    report = dict(scenario=scenario, seconds_requested=seconds, duration=duration, cycles=len(turns),
        clock='Fixed fixture epoch + actual monotonic elapsed milliseconds; no event-count jumps or future observations',
        process_cpu_percent=100 * cpu / duration, queries=dict(queries), worker_sql_per_second=queries['total']/duration,
        cgroup_before=cgroup_before, cgroup_after=cgroup_after,
        cpu_scope='Worker, input, M1 validation and wait-sampler in same capped Python process; final full hash excluded',
        before=before, after=after, before_state=before_state, after_state=after_state,
        payload_unchanged=before['sha256']==after['sha256'], visible_metadata_unchanged=before_visible==after_visible,
        publications_timestamp_changed=sum(a['updated_at']!=z['updated_at'] for a,z in zip(before['publications'], after['publications'])),
        events=events, unpublished_events=pending,
        inputs_by_identity={ident: dict(Counter(e['kind'] for e in events+pending if e['instrument']==ident)) for ident in b.IDENTITIES},
        latency_completed_only=quantiles([e['latency_seconds'] for e in events]),
        unpublished_before_final30s=sum(e['committed_seconds']<=duration-30 for e in pending),
        longest_target_wait=max([t['target_wait'] for t in turns]+[r['seconds'] for r in unresolved]+[0]),
        final_unserved_ready=unresolved,
        by_target={str(key):dict(turns=sum(t['target'] is not None and tuple(t['target'])==key for t in turns),
            last_seen_seconds=max(t['at'] for t in turns if t['target'] is not None and tuple(t['target'])==key)) for key in fairness},
        lock_sample_count=len(locks),lock_wait_samples=sum(any(r['wait_event_type']=='Lock' for r in sample['connections']) for sample in locks),
        lock_sample_errors=sample_errors,
        limitations=['Single supplemental run, not replacement for frozen three-repetition suite',
            'Full before/after bar hash proves idle stability, not independent high-period OHLC correctness',
            'No external lock holders; sampled absence cannot exclude short waits',
            'No network API, alert threads, provider, browser, notifications or production SLA'])
    if scenario == 'idle':
        assert report['payload_unchanged'] and report['visible_metadata_unchanged'], 'idle visible snapshot changed'
    else:
        assert sequence == 20 and all(v == {'new_bar':1, 'observation':1} for v in report['inputs_by_identity'].values())
    save(scenario + '.json', report)
    print(json.dumps({k: report[k] for k in ['scenario','duration','cycles','process_cpu_percent',
        'worker_sql_per_second','payload_unchanged','publications_timestamp_changed',
        'latency_completed_only','unpublished_before_final30s','longest_target_wait','lock_wait_samples']}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--scenario', choices=['idle','mixed'], default='mixed')
    parser.add_argument('--seconds', type=int, default=300)
    args = parser.parse_args()
    if args.seconds < 200:
        raise SystemExit('At least 200 seconds required to submit all 20 inputs and observe a tail')
    ROOT.mkdir(exist_ok=True)
    measure(args.scenario, args.seconds)
