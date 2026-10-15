"""Measure read-only OANDA latest-candle batches in isolated Ubuntu Docker."""
import collections
import datetime
import json
import math
import pathlib
import statistics
import time

import httpx
from alerts.config import settings

ROOT = pathlib.Path('/evidence')
SYMBOLS = ['EUR_USD', 'GBP_USD', 'USD_JPY', 'USD_CHF', 'AUD_USD', 'NZD_USD',
           'USD_CAD', 'EUR_JPY', 'GBP_JPY', 'EUR_GBP', 'AUD_JPY', 'XAU_USD']
SAMPLES, RESULTS = [], []
client = httpx.Client(proxy=settings.oanda_proxy or settings.market_proxy or None,
    trust_env=False, timeout=7, limits=httpx.Limits(max_connections=1, max_keepalive_connections=1))


def stats(values):
    a = sorted(values)
    return {'count':len(a), 'median':round(statistics.median(a),3) if a else None,
            'p95':round(a[max(0,math.ceil(.95*len(a))-1)],3) if a else None,
            'max':round(max(a),3) if a else None}


def run(symbols, duration):
    name = f'latest_batch_{len(symbols)}'
    start, cpu, stamp = time.monotonic(), time.process_time(), int(time.time()*1000)
    tick, last_progress, skipped = start, start, 0
    complete, first = {}, len(SAMPLES)
    print(json.dumps({'phase':name,'duration_seconds':duration,'state':'starting'}),flush=True)
    while time.monotonic()-start < duration:
        if tick > time.monotonic():time.sleep(tick-time.monotonic())
        if time.monotonic()-start >= duration:break
        reqstart, at = time.monotonic(), int(time.time()*1000)
        sample = {'phase':name,'started_ms':at}
        try:
            r = client.get('https://api-fxpractice.oanda.com/v3/accounts/'+settings.oanda_account_id+'/candles/latest',
                headers={'Authorization':'Bearer '+settings.oanda_token,'Accept-Datetime-Format':'UNIX'},
                params={'candleSpecifications':','.join(s+':M1:B' for s in symbols),'smooth':'false'})
            sample.update(status=r.status_code,body_bytes=len(r.content))
            r.raise_for_status()
            groups = r.json().get('latestCandles',[])
            sample['returned_groups'] = len(groups)
            sample['returned_instruments'] = sorted(set(g['instrument'] for g in groups))
            sample['candles_per_group'] = [len(g['candles']) for g in groups]
            sample['has_forming_per_group'] = [any(not c['complete'] for c in g['candles']) for g in groups]
            sample['has_complete_per_group'] = [any(c['complete'] for c in g['candles']) for g in groups]
            sample['all_groups_have_volume'] = all('volume' in c for g in groups for c in g['candles'])
            for g in groups:
                for c in g['candles']:
                    end = int(float(c['time'])*1000)+60000
                    if c['complete'] and end >= stamp:
                        complete.setdefault((g['instrument'],end),int(time.time()*1000))
            if set(sample['returned_instruments']) != set(symbols):sample['error']='IncompleteBatchCoverage'
        except Exception as error:
            sample['error'] = type(error).__name__
        sample['elapsed_ms'] = round((time.monotonic()-reqstart)*1000,3)
        SAMPLES.append(sample)
        if sample.get('status') in (400,401,403,404):
            print(json.dumps({'phase':name,'state':'unsupported_or_rejected','status':sample['status']}),flush=True)
            break
        tick += 1
        if tick < time.monotonic():
            missed = math.ceil(time.monotonic()-tick);skipped+=missed;tick+=missed
        if time.monotonic()-last_progress >= 30:
            (ROOT/'batch-samples.json').write_text(json.dumps(SAMPLES,indent=2)+'\n')
            print(json.dumps({'phase':name,'elapsed_seconds':round(time.monotonic()-start,1),'requests':len(SAMPLES)-first}),flush=True)
            last_progress=time.monotonic()
    a=SAMPLES[first:];elapsed=time.monotonic()-start
    delays=[{'instrument':s,'minute_end_ms':end,'first_complete_after_boundary_ms':seen-end}
            for (s,end),seen in sorted(complete.items())]
    out={'phase':name,'started_ms':stamp,'duration_seconds':round(elapsed,3),'specifications':symbols,
        'requests':len(a),'rps':round(len(a)/elapsed,3),'skipped_ticks':skipped,
        'statuses':dict(collections.Counter(str(x.get('status')) for x in a)),
        'errors':dict(collections.Counter(x['error'] for x in a if x.get('error'))),
        'request_ms':stats([x['elapsed_ms'] for x in a]),
        'request_start_gap_ms':stats([y['started_ms']-x['started_ms'] for x,y in zip(a,a[1:])]),
        'mean_body_bytes':round(statistics.mean([x.get('body_bytes',0) for x in a]),3) if a else None,
        'cpu_seconds':round(time.process_time()-cpu,3),
        'cpu_one_core_percent':round((time.process_time()-cpu)/elapsed*100,3),
        'group_counts':dict(collections.Counter(str(x.get('returned_groups')) for x in a)),
        'all_samples_cover_requested_instruments':all(set(x.get('returned_instruments',[]))==set(symbols) for x in a),
        'all_groups_have_volume':all(x.get('all_groups_have_volume',False) for x in a),
        'samples_with_forming_for_every_group':sum(all(x.get('has_forming_per_group',[False])) for x in a),
        'samples_with_complete_for_every_group':sum(all(x.get('has_complete_per_group',[False])) for x in a),
        'minute_confirmations':delays}
    RESULTS.append(out)
    (ROOT/'batch-samples.json').write_text(json.dumps(SAMPLES,indent=2)+'\n')
    (ROOT/'batch-summary.json').write_text(json.dumps({'phases':RESULTS},indent=2)+'\n')
    print(json.dumps({k:v for k,v in out.items() if k!='minute_confirmations'}),flush=True)


run(SYMBOLS[:1],30)
run(SYMBOLS,120)
client.close()
