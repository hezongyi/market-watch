#!/usr/bin/env python3
"""HTTPS smoke against the real persistent development instance (no fixtures)."""
import http.cookiejar
import json
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

STATE = Path.home() / '.local/share/market-watch-dev'
credentials = json.loads((STATE / 'credentials.json').read_text())
base = credentials['base_url']
context = ssl.create_default_context(cafile=credentials['ca_file'])
cookies = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=context),
                                   urllib.request.HTTPCookieProcessor(cookies))


def call(path, data=None):
    headers = {'Content-Type': 'application/json'}
    if data is not None and path != '/api/login':
        headers['x-csrf-token'] = csrf
    request = urllib.request.Request(base + path, headers=headers,
                                    data=None if data is None else json.dumps(data).encode())
    with opener.open(request, timeout=100) as response:
        return json.load(response)


def source_read(source, query, frame):
    params = urllib.parse.urlencode(dict(kind='provider', query=query, source=source, limit=25))
    rows = call('/api/market-data/series/search?' + params)
    if isinstance(rows, dict):
        rows = rows.get('items', [])
    candidates = [r for r in rows if r.get('source') == source and r.get('available', True)]
    if not candidates:
        return dict(source=source, status='catalog_empty')
    row = candidates[0]
    for attempt in range(2):
        try:
            reply = call('/api/charts/data', dict(instrument=row['id'], series_kind='provider',
                                               timeframe=frame, limit=40, firstDataRequest=True))
            break
        except urllib.error.HTTPError as error:
            if attempt or error.code not in {502, 503, 504}:
                raise
            time.sleep(2)
    bars = reply.get('bars', [])
    return dict(source=source, status='ok' if bars else 'empty', bars=len(bars), frame=frame)


if __name__ == '__main__':
    for attempt in range(30):
        try:
            assert call('/readyz')['status'] == 'ready'
            break
        except (urllib.error.URLError, AssertionError):
            if attempt == 29:
                raise
            time.sleep(1)
    csrf = call('/api/login', {'password': credentials['login_password']})['csrf']
    result = dict(https=True, login=True,
                  saved_workspaces=len(call('/api/advanced-charts/workspaces')),
                  saved_preferences=len(call('/api/advanced-charts/preferences')),
                  chart_alerts=len(call('/api/chart-alerts')))
    # The refreshes discover actual account catalogs; they never create a trade.
    for source in ['oanda', 'fxcm']:
        try:
            call('/api/market-data/history-catalog/refresh', {'source': source})
            result[source + '_catalog'] = 'ok'
        except Exception as error:
            result[source + '_catalog'] = type(error).__name__
    result['sources'] = []
    probes = [('oanda', 'EURUSD', 'H1'), ('binance', 'BTCUSDT', 'H1'),
              ('dukascopy', 'EURUSD', 'H1'), ('yahoo', 'SPY', 'D1'),
              ('akshare', '000001', 'D1'), ('fxcm', 'EURUSD', 'H1')]
    with ThreadPoolExecutor(max_workers=3) as pool:
        jobs = {pool.submit(source_read, *probe): probe[0] for probe in probes}
        for future in as_completed(jobs):
            try:
                row = future.result()
            except Exception as error:
                row = dict(source=jobs[future], status=type(error).__name__,
                           http_status=getattr(error, 'code', None))
            result['sources'].append(row)
            print(json.dumps(row), flush=True)
    result['notification_test'] = call('/api/notification-tests', {})['status']
    time.sleep(3)
    health = call('/api/health')
    result['notification_delivery'] = health['last_notification_test']
    result['runtime'] = {group: [dict(role=r['role'], state=r['state'], error=r.get('error_type'))
                                for r in health[group]]
                         for group in ['market_runtime', 'data_runtime', 'notification_runtime']}
    path = STATE / 'evidence/development-smoke.json'
    path.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    path.chmod(0o600)
    print(json.dumps({k: v for k, v in result.items() if k not in ['runtime', 'sources']},
                     ensure_ascii=False), flush=True)
    assert all(row['status'] == 'ok' for row in result['sources']), 'A real source read failed'
    assert result['notification_delivery']['status'] == 'notification_test_accepted'
    assert all(row['state'] not in {'missing', 'stale', 'degraded', 'failed'} and not row['error']
               for rows in result['runtime'].values() for row in rows), 'Runtime is unhealthy'
