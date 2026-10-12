"""Isolated PG phase measurement and streaming comparison with baseline code.

No supplier import or production data. Instrumentation adds Python call overhead;
phase times are exclusive wall seconds, SQL includes server/lock waiting. The
reference is the unchanged aggregation functions from the implementation baseline,
not a reimplementation using the optimized functions.
"""
import contextlib
import gzip
import hashlib
import json
import os
import resource
import subprocess
import time
import types
import uuid
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

from sqlalchemy import create_engine, event, select, text
from sqlalchemy.orm import sessionmaker
from alerts import storage, history_artifacts as a, history_versions as h
from alerts.chart_data import FRAMES
from alerts.market_contracts import DatasetIdentity
from alerts.market_datasets import register_dataset

ROOT = Path(__file__).resolve().parents[3]
BASELINE = '7b5c61416390d6db2c26ccdde07716b81affc36c'
reference_source = subprocess.check_output(
    ['git', 'show', BASELINE + ':backend/alerts/history_artifacts.py'], cwd=ROOT, text=True)
reference = types.ModuleType('alerts._derive_baseline')
reference.__package__ = 'alerts'
exec(compile(reference_source, 'baseline/history_artifacts.py', 'exec'), reference.__dict__)
url = os.environ['TEST_POSTGRES_URL']
assert ':19995/' in url and url.endswith('/pro_charts')
rows_target = int(os.getenv('DERIVE_ROWS', '2147763'))
out = Path(__file__).with_name('derive-contract-' + str(rows_target) + '.json')
report = {'scope': 'Ubuntu isolated PostgreSQL; synthetic real-shape M1; nine actual period artifacts',
          'rows': rows_target, 'baseline': BASELINE,
          'baseline_source_sha256': hashlib.sha256(reference_source.encode()).hexdigest(),
          'frames': FRAMES, 'phases': {}, 'ticks': 0, 'decode_calls': 0,
          'reference': [], 'intentional_wait_seconds': 0,
          'measurement_limit': 'Exclusive instrumented wall times; SQL read time includes lock waits. '
              'No injected waits. Instrumentation overhead is included; no supplier throughput claim.'}
timers, stack, measuring = {}, [], False

def enter(name):
    stack.append([name, time.perf_counter(), 0.])

def leave():
    name, started, nested = stack.pop()
    duration = time.perf_counter() - started
    timers[name] = timers.get(name, 0.) + duration - nested
    if stack:
        stack[-1][2] += duration

def timed(name, fn):
    def call(*args, **kwargs):
        if not measuring:
            return fn(*args, **kwargs)
        enter(name)
        try:
            return fn(*args, **kwargs)
        finally:
            leave()
    return call

admin = create_engine(url)
schema = 'pro_charts_contract_' + uuid.uuid4().hex
with admin.begin() as db:
    db.execute(text(f'CREATE SCHEMA {schema}'))
engine = create_engine(url, connect_args={'options': f'-csearch_path={schema}'}, pool_size=2, max_overflow=0)
storage.Base.metadata.create_all(engine)
factory = sessionmaker(engine, expire_on_commit=False)
storage.Session = factory

@event.listens_for(engine, 'before_cursor_execute')
def sql_start(conn, cursor, statement, parameters, context, executemany):
    if measuring:
        enter('sql_read_and_wait' if statement.lstrip().upper().startswith('SELECT') else 'sql_write')

@event.listens_for(engine, 'after_cursor_execute')
def sql_end(conn, cursor, statement, parameters, context, executemany):
    if measuring:
        leave()

original_transaction = a.transaction
@contextlib.contextmanager
def transaction():
    manager = original_transaction()
    db = manager.__enter__()
    try:
        yield db
    except BaseException:
        manager.__exit__(*__import__('sys').exc_info())
        raise
    else:
        if measuring:
            enter('flush_commit_and_wait')
        try:
            manager.__exit__(None, None, None)
        finally:
            if measuring:
                leave()

a.transaction = transaction
a._page_input = timed('checksum_calendar_cache_and_materialization', a._page_input)
a.compressed_chunk = timed('source_content_access', a.compressed_chunk)
original_normalize = a.version_price_rows
def normalize(*args):
    if measuring:
        report['decode_calls'] += 1
    return original_normalize(*args)
a.version_price_rows = timed('decode_price_normalization', normalize)
a.json = types.SimpleNamespace(loads=timed('decode_json', json.loads), dumps=timed('encode_json', json.dumps))
a.gzip = types.SimpleNamespace(decompress=timed('decode_gzip', gzip.decompress), compress=timed('encode_gzip', gzip.compress))
a._pair = timed('bucket_keys', a._pair)
a._add = timed('decimal_aggregation', a._add)
a._finish = timed('coverage_finalize', a._finish)
identity = DatasetIdentity(source='dukascopy', channel='python', environment='historical',
    account_scope='public', provider_symbol='EUR/USD', basis='bid', calendar_version='synthetic-contract-v1')
start = int(datetime(2019, 1, 1, tzinfo=UTC).timestamp() * 1000)

def legacy_rows(db, version, instrument, dataset, frame):
    state = {}
    for chunk in db.scalars(select(storage.HistoryChunk).where(
            storage.HistoryChunk.version_id == version.id).order_by(storage.HistoryChunk.start)):
        for row in reference.version_price_rows(json.loads(reference.raw_chunk(db, chunk)), version.manifest):
            left, right = reference._pair(row['timestamp'], frame, instrument)
            if state and state['start'] != left:
                yield reference._finish(state, instrument, version, dataset)
                state = {}
            if not state:
                state = {'start': left, 'end': right}
            reference._add(state, row, instrument)
    if state:
        yield reference._finish(state, instrument, version, dataset)

try:
    before = time.perf_counter()
    with factory.begin() as db:
        register_dataset(db, identity, logical_symbol='EURUSD', label='Synthetic contract fixture',
            calendar='ny17', precision=5, volume_kind='quantity', volume_unit='source_quantity')
        v = storage.HistoryVersion(dataset_id=identity.key, start=start, end=start+60000, cursor=start,
            manifest={'price_rule_version': 'dataset-precision-half-up-v1', 'price_precision': 5})
        db.add(v); db.flush(); vid = v.id
        cursor, observed = start, 0
        while observed < rows_target:
            left, rows = cursor, []
            while len(rows) < 44000 and observed < rows_target:
                index = (cursor-start)//60000
                weekday = (1+index//1440) % 7
                if weekday < 5 and index % 997 not in (0, 1, 2):
                    value = Decimal(112000+index%101)/100000
                    rows.append({'timestamp': cursor, 'open': str(value), 'high': str(value+Decimal('.00011')),
                        'low': str(value-Decimal('.00007')), 'close': str(value+Decimal('.00002')),
                        'volume': None if index%137 == 0 else '1.25', 'complete': index%211 != 0})
                    observed += 1
                cursor += 60000
            raw = json.dumps(rows, sort_keys=True, separators=(',', ':')).encode()
            db.add(storage.HistoryChunk(version_id=vid, start=left, end=cursor, observed_at=cursor+5000,
                count=len(rows), checksum=hashlib.sha256(raw).hexdigest(), content=gzip.compress(raw, mtime=0),
                result='data', unknown=[]))
        v.end = v.cursor = cursor
        db.flush(); h.publish(db, v); a.request_artifacts(db, v, FRAMES)
    report['fixture_publish_seconds'] = time.perf_counter()-before
    with a._input_lock:
        a._inputs.clear(); a._input_bytes = 0
    before = time.perf_counter(); longest = cache_peak = 0
    measuring = True
    while True:
        tick_start = time.perf_counter()
        worked = a.artifact_tick(vid)
        duration = time.perf_counter()-tick_start
        if not worked:
            break
        report['ticks'] += 1
        longest = max(longest, duration); cache_peak = max(cache_peak, a._input_bytes)
        if report['ticks'] % 100 == 0:
            print(json.dumps({'phase': 'derive', 'ticks': report['ticks'], 'seconds': time.perf_counter()-before}), flush=True)
    measuring = False
    report['nine_period_end_to_end_seconds'] = time.perf_counter()-before
    report['phases'] = timers
    report['unassigned_python_and_measurement_seconds'] = report['nine_period_end_to_end_seconds']-sum(timers.values())
    report['longest_tick_seconds'] = longest
    report['cache_high_water_bytes'] = cache_peak
    report['derivation_peak_rss_kib'] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    assert cache_peak <= a._INPUT_LIMIT
    before = time.perf_counter()
    with factory() as db:
        version = db.get(storage.HistoryVersion, vid)
        dataset = db.get(storage.MarketDataset, version.dataset_id)
        instrument = db.get(storage.Instrument, dataset.instrument_id)
        report['periods'] = [{k: p[k] for k in ('timeframe', 'status', 'rows', 'complete_rows')}
                            for p in a.artifact_report(db, vid)]
        assert len(report['periods']) == 9 and all(p['status'] == 'published' for p in report['periods'])
        report['progress'] = a.derivation_progress(db, version)
        assert report['progress']['processed_rows'] == report['progress']['total_rows'] == rows_target*9
        for frame in FRAMES:
            frame_start = time.perf_counter()
            actual = iter(a.iter_artifact(db, vid, frame))
            count, minutes = 0, 0
            current_digest, baseline_digest = hashlib.sha256(), hashlib.sha256()
            for expected in legacy_rows(db, version, instrument, dataset, frame):
                current = next(actual, None)
                assert current == expected, (frame, count, current, expected)
                count += 1; minutes += current['observed_minutes']
                current_digest.update(json.dumps(current, sort_keys=True, separators=(',', ':')).encode())
                baseline_digest.update(json.dumps(expected, sort_keys=True, separators=(',', ':')).encode())
            assert next(actual, None) is None and minutes == rows_target
            comparison = {'frame': frame, 'buckets_compared': count, 'observed_minutes': minutes,
                'all_fields_equal': True, 'current_sha256': current_digest.hexdigest(),
                'baseline_sha256': baseline_digest.hexdigest(), 'seconds': time.perf_counter()-frame_start}
            report['reference'].append(comparison)
            print(json.dumps({'phase': 'baseline_compare', **comparison}), flush=True)
    report['reference_comparison_seconds'] = time.perf_counter()-before
    report['whole_process_peak_rss_kib'] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    report['passed'] = True
finally:
    measuring = False
    engine.dispose()
    with admin.begin() as db:
        db.execute(text(f'DROP SCHEMA {schema} CASCADE'))
    report['isolated_schema_removed'] = True
    admin.dispose()
    out.write_text(json.dumps(report, indent=2))
    print(json.dumps({'out': str(out), 'passed': report.get('passed', False)}), flush=True)
