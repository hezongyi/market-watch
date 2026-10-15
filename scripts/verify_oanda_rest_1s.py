"""Read-only supplier benchmark; run only in an isolated Ubuntu Docker project.

No price values, account identity, URLs, headers or exception text are recorded.
Private credentials come from the container environment. Database writes target
only the isolated benchmark PostgreSQL database. This does not exercise a chart.
"""

import collections
import json
import math
import os
import pathlib
import resource
import statistics
import time

import httpx
from sqlalchemy import event, select, text

from alerts import provider_cache, provider_chart, provider_service
from alerts.config import settings
from alerts.market_resources import lane
from alerts.storage import ProviderInterest, bootstrap, engine, now_ms, transaction

ROOT = pathlib.Path('/evidence')
SAMPLES = []
HTTP = []
PHASE = 'setup'
SQL_COUNT = 0
COMPLETE = {}
BASELINE_COMPLETE = {}


def save():
    (ROOT / 'samples.json').write_text(json.dumps(SAMPLES, indent=2) + '\n')
    (ROOT / 'http.json').write_text(json.dumps(HTTP, indent=2) + '\n')


def percentile(values, fraction):
    values = sorted(values)
    return round(values[max(0, math.ceil(len(values) * fraction) - 1)], 3) if values else None


def stats(values):
    return {'count': len(values), 'min': round(min(values), 3) if values else None,
            'median': round(statistics.median(values), 3) if values else None,
            'p95': percentile(values, .95), 'max': round(max(values), 3) if values else None}


@event.listens_for(engine, 'before_cursor_execute')
def count_sql(*args):
    global SQL_COUNT
    SQL_COUNT += 1


# Instrument actual HTTP transport calls, including pooled adapter clients.
# Keep exception classification bounded and never persist request/response bodies.
original_send = httpx.Client.send


def measured_send(client, request, *args, **kwargs):
    started = time.monotonic()
    record = {'phase': PHASE, 'started_ms': now_ms()}
    try:
        response = original_send(client, request, *args, **kwargs)
        record['status'] = response.status_code
        if not kwargs.get('stream'):
            record['body_bytes'] = len(response.content)
            record['header_bytes'] = sum(len(k) + len(v) + 4 for k, v in response.headers.raw)
            try:
                candles = response.json().get('candles', [])
                record['candle_count'] = len(candles)
                for candle in candles:
                    start = int(float(candle['time']) * 1000)
                    if candle.get('complete') and start + 60000 >= RUN_START:
                        record.setdefault('closed_minute_ends', []).append(start + 60000)
                        if PHASE == 'direct_fixed_1s':
                            COMPLETE.setdefault(start + 60000, now_ms())
            except (ValueError, TypeError, KeyError):
                pass
        return response
    except Exception as error:
        record['error'] = type(error).__name__
        raise
    finally:
        record['elapsed_ms'] = round((time.monotonic() - started) * 1000, 3)
        HTTP.append(record)


httpx.Client.send = measured_send
RUN_START = now_ms()
bootstrap()
meta = provider_chart.metadata('EURUSD')
proxy = settings.oanda_proxy or settings.market_proxy or None
client = httpx.Client(proxy=proxy, trust_env=False, timeout=7,
                     limits=httpx.Limits(max_connections=1, max_keepalive_connections=1))


def direct():
    response = client.get('https://api-fxpractice.oanda.com/v3/instruments/EUR_USD/candles',
        headers={'Authorization': 'Bearer ' + settings.oanda_token,
                 'Accept-Datetime-Format': 'UNIX'},
        params={'granularity': 'M1', 'price': 'B', 'smooth': 'false', 'count': 3})
    response.raise_for_status()
    return {'rows': len(response.json()['candles'])}


def cached():
    with lane('realtime'):
        page = provider_cache.read(meta, 'M1', (now_ms() // 1000 + 1) * 1000, 3, latest=True)
    return {'rows': len(page['bars']), 'cache_hit': page.get('cache_hit'),
            'timings_ms': page.get('timings_ms')}


def legacy_loop():
    provider_service.renew('bench')
    provider_service.realtime_step('oanda')
    return {}


def run(name, duration, period, operation, fixed=True):
    global PHASE
    PHASE = name
    start, wall, cpu, sql = time.monotonic(), now_ms(), time.process_time(), SQL_COUNT
    next_tick, skipped = start, 0
    start_http = len(HTTP)
    print(json.dumps({'phase': name, 'state': 'starting', 'duration_seconds': duration}), flush=True)
    last_progress = start
    while time.monotonic() - start < duration:
        if fixed:
            remaining = next_tick - time.monotonic()
            if remaining > 0:
                time.sleep(remaining)
            if time.monotonic() - start >= duration:
                break
        tick, stamp = time.monotonic(), now_ms()
        sample = {'phase': name, 'started_ms': stamp}
        try:
            sample.update(operation())
        except Exception as error:
            sample['error'] = type(error).__name__
        sample['elapsed_ms'] = round((time.monotonic() - tick) * 1000, 3)
        SAMPLES.append(sample)
        if name == 'direct_fixed_1s' and stamp - wall >= len(BASELINE_TICKS) * 15000:
            BASELINE_TICKS.append(stamp)
            for end in HTTP[-1].get('closed_minute_ends', []):
                BASELINE_COMPLETE.setdefault(end, now_ms())
        if fixed:
            next_tick += period
            if next_tick < time.monotonic():
                missed = math.ceil((time.monotonic() - next_tick) / period)
                skipped += missed
                next_tick += missed * period
        else:
            time.sleep(period)  # Existing provider worker's sleep-after-work loop.
        if time.monotonic() - last_progress >= 30:
            save()
            print(json.dumps({'phase': name, 'elapsed_seconds': round(time.monotonic()-start, 1),
                              'http_requests': len(HTTP)-start_http,
                              'errors': sum(bool(x.get('error')) for x in HTTP[start_http:])}), flush=True)
            last_progress = time.monotonic()
    save()
    elapsed = time.monotonic() - start
    samples = [x for x in SAMPLES if x['phase'] == name]
    reqs = HTTP[start_http:]
    gaps = [b['started_ms']-a['started_ms'] for a,b in zip(reqs, reqs[1:])]
    totals = {'phase': name, 'started_ms': wall, 'duration_seconds': round(elapsed, 3),
        'polls': len(samples), 'http_requests': len(reqs), 'skipped_ticks': skipped,
        'http_rps': round(len(reqs)/elapsed, 3), 'request_ms': stats([x['elapsed_ms'] for x in reqs]),
        'request_start_gap_ms': stats(gaps), 'poll_ms': stats([x['elapsed_ms'] for x in samples]),
        'statuses': dict(collections.Counter(str(x.get('status', x.get('error'))) for x in reqs)),
        'poll_errors': dict(collections.Counter(x['error'] for x in samples if x.get('error'))),
        'body_bytes': sum(x.get('body_bytes',0) for x in reqs),
        'response_header_bytes': sum(x.get('header_bytes',0) for x in reqs),
        'process_cpu_seconds': round(time.process_time()-cpu, 3),
        'process_cpu_one_core_percent': round((time.process_time()-cpu)/elapsed*100, 3),
        'sql_statements': SQL_COUNT-sql,
        'max_rss_kib': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}
    RESULTS.append(totals)
    (ROOT / 'summary.json').write_text(json.dumps({'phases': RESULTS},indent=2)+'\n')
    print(json.dumps(totals), flush=True)


BASELINE_TICKS = []
RESULTS = []
skip_direct = os.environ.get('OANDA_REST_SKIP_DIRECT') == '1'
if not skip_direct:
    run('direct_fixed_1s', 300, 1, direct)
client.close()
if os.environ.get('OANDA_REST_GUARD_TO') == '1':
    # Benchmark-only guard: expose scheduling/cache cost after ruling out the
    # supplier's future-to rejection. This is NOT a production adapter change.
    if os.environ.get('OANDA_REST_GUARD_SCOPE') == 'read':
        original_read = provider_cache.read

        def guarded_read(meta, frame, before, count, **kwargs):
            return original_read(meta, frame, min(before, now_ms()-2000), count, **kwargs)

        provider_cache.read = guarded_read
    else:
        original_page = provider_chart.native_page

        def guarded_page(meta, frame, before, count, **kwargs):
            return original_page(meta, frame, min(before, now_ms()-2000), count, **kwargs)

        provider_chart.native_page = guarded_page
settings.provider_fresh_seconds = 15
settings.market_poll_seconds = 15
provider_service.subscribe('bench', 'm1', 'EURUSD', 'M1')
only_cached = os.environ.get('OANDA_REST_ONLY_CACHED') == '1'
if not only_cached:
    run('backend_current_15s', 45 if skip_direct else 60, 1, legacy_loop, fixed=False)
settings.provider_fresh_seconds = 1
settings.market_poll_seconds = 1
with transaction() as db:
    db.get(ProviderInterest, provider_service.interest_id('bench','m1')).next_poll = 0
if not only_cached:
    run('backend_config_only_1s', 60 if skip_direct else 90, 1, legacy_loop, fixed=False)
run('backend_fixed_1s', 90 if skip_direct else 120, 1, cached)
delays = [{'minute_end_ms': end, 'first_complete_after_boundary_ms': observed-end,
           'virtual_15s_first_complete_after_boundary_ms': BASELINE_COMPLETE.get(end, 0)-end
               if end in BASELINE_COMPLETE else None}
          for end,observed in sorted(COMPLETE.items())]
with engine.connect() as db:
    db_bytes = db.scalar(text('SELECT pg_database_size(current_database())'))
    pg_stats = dict(db.execute(text("SELECT xact_commit,xact_rollback,blks_read,blks_hit,tup_inserted,tup_updated,tup_deleted FROM pg_stat_database WHERE datname=current_database()" )).mappings().one())
direct_phase = RESULTS[0] if not skip_direct else None
fixed_phase = RESULTS[-1]
gates = {
    'backend_fixed_1s_cadence': fixed_phase['polls']/fixed_phase['duration_seconds'] >= .95,
    'backend_fixed_one_request_per_poll': fixed_phase['http_requests'] <= fixed_phase['polls'],
    'backend_fixed_all_requests_successful': fixed_phase['statuses'] == {'200': fixed_phase['http_requests']},
    'backend_fixed_no_poll_errors': not fixed_phase['poll_errors'],
}
if direct_phase:
    gates.update(supplier_1s_cadence=direct_phase['http_rps'] >= .95,
        supplier_all_requests_successful=direct_phase['statuses'] == {'200': direct_phase['http_requests']},
        at_least_three_minute_confirmations=len(delays) >= 3)
final = {'started_ms': RUN_START, 'finished_ms': now_ms(), 'phases': RESULTS, 'gates': gates,
    'benchmark_only_to_guard': os.environ.get('OANDA_REST_GUARD_TO') == '1',
    'benchmark_only_to_guard_scope': os.environ.get('OANDA_REST_GUARD_SCOPE','page'),
    'minute_confirmations': delays, 'pg_database_bytes': db_bytes, 'pg_stats': pg_stats,
    'scope': 'Ubuntu Docker, EUR_USD BID M1 count=3, configured proxy, no charts/studies; virtual 15s comparator samples the same 1s responses, not a separate concurrent client'}
(ROOT / 'summary.json').write_text(json.dumps(final, indent=2)+'\n')
print(json.dumps({'state':'complete','minute_confirmations':delays,'pg_database_bytes':db_bytes}),flush=True)
