"""Research runner. Only chart_sync PG; process-local capacity/budget experiment.

Run in a disposable container with the acceptance API image and private env_file.
Never alter the running API, product source, credentials, schema or provider rows.
Only normal provider cache backfill is persisted. No client interests are created.
"""
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path
sys.path.insert(0, '/app')
from sqlalchemy.engine import make_url
from alerts.config import settings
from alerts.chart_api import DataQuery, NativeHistory
from alerts import provider_cache as cache
from alerts import provider_chart as upstream

url = make_url(settings.database_url)
assert url.host == 'pg' and url.database == 'chart_sync'
assert settings.delivery_enabled is False
OUT = Path(os.environ.get('LARGE_PROVIDER_OUTPUT', '/research'))
OUT.mkdir(parents=True, exist_ok=True)
report = {'scope': 'Disposable image process, same unmodified provider cache code and isolated chart_sync PG. Capacity and deadline changed only in this process; HTTP/model limits bypassed with model_construct. No client interest.', 'cases': []}
settings.provider_request_seconds = 300
original_page = upstream.native_page
active = None

def page(*args, **kwargs):
    started = time.monotonic()
    try:
        result = original_page(*args, **kwargs)
        active['pages'].append({'ms': (time.monotonic()-started)*1000, 'count': len(result.get('bars', []))})
        return result
    except Exception as error:
        active['pages'].append({'ms': (time.monotonic()-started)*1000, 'error': type(error).__name__})
        raise

upstream.native_page = page
cases = json.loads(os.environ.get('LARGE_PROVIDER_CASES', json.dumps([
    {'n': 20000, 'before': '2011-02-01T00:00:00+00:00'},
    {'n': 60000, 'before': '2013-02-01T00:00:00+00:00'},
    {'n': 200000, 'before': '2009-02-01T00:00:00+00:00'},
])))
for case in cases:
    for repeat in range(3):
        active = {'case': case, 'repeat': repeat, 'pages': []}
        started = time.monotonic()
        before = int(datetime.fromisoformat(case['before']).timestamp()*1000)
        n = case['n']
        indicators = case.get('indicators', [])
        cache.CAPACITY = n + 2001
        body = DataQuery.model_construct(instrument='EURUSD', series_kind='provider',
            timeframe=case.get('frame', 'M5'), limit=n, count_back=n, before=before,
            from_time=None, first_data_request=False, client=None, indicators=indicators,
            native_history=NativeHistory(chart_count=4, focused=True, historical_navigation=True),
            history_observation=None, native_reserve=None)
        try:
            result = cache.data(body)
            active.update(ms=(time.monotonic()-started)*1000, count=len(result['bars']),
                cache_hit=result.get('cache_hit'), timings_ms=result.get('timings_ms'),
                first=result['bars'][0]['chart_time'] if result['bars'] else None,
                last=result['bars'][-1]['chart_time'] if result['bars'] else None,
                boundary=result.get('history_boundary'), indicator_series=len(result.get('indicators', [])))
            began=time.monotonic()
            raw=json.dumps(result, separators=(',', ':')).encode()
            active.update(json_bytes=len(raw), serialize_ms=(time.monotonic()-began)*1000)
            if repeat == 1 and not indicators:
                (OUT/f"provider-{n}.json").write_bytes(raw)
            assert len(result['bars']) >= n or result.get('history_boundary') or result.get('window_limit')
            active['passed'] = True
        except Exception as error:
            active.update(ms=(time.monotonic()-started)*1000, error=type(error).__name__+': '+str(error))
        report['cases'].append(active)
        (OUT/'provider-results.json').write_text(json.dumps(report, indent=2))
        print(json.dumps(active), flush=True)
