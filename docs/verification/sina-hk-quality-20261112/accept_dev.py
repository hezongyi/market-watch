"""Real API acceptance of the authorized development instance, without fixtures.

MW_ACCEPTANCE_CREDENTIALS_FILE: private JSON {base_url, login_password, ca_file}.
MW_OUTPUT: public JSON output path. No credentials are copied to the report.
"""

import json
import os
import ssl
import time
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

import httpx
from alerts.akshare_catalog import stable_id

config = json.loads(Path(os.environ['MW_ACCEPTANCE_CREDENTIALS_FILE']).read_text())
output = Path(os.environ['MW_OUTPUT'])
report = {'at': datetime.now(UTC).isoformat(), 'legacy_hk': [], 'regressions': [], 'passed': False}


def assert_bars(page, expected):
    assert len(page['bars']) == expected
    for row in page['bars']:
        opening, high, low, closing = [Decimal(str(row[k])) for k in ('open', 'high', 'low', 'close')]
        assert min(opening, high, low, closing) > 0 and low <= min(opening, closing) <= max(opening, closing) <= high


with httpx.Client(base_url=config['base_url'], trust_env=False, timeout=100,
                  verify=ssl.create_default_context(cafile=config['ca_file'])) as client:
    def call(path, body=None, **kwargs):
        response = client.get(path, **kwargs) if body is None else client.post(path, json=body, **kwargs)
        assert response.is_success, f'{path}: HTTP {response.status_code}'
        return response.json()

    client.headers['x-csrf-token'] = call('/api/login', {'password': config['login_password']})['csrf']
    for symbol, expected_bad in [('00700', 2), ('02318', 4), ('00941', 27), ('00005', 3)]:
        ident = stable_id('HKEX:' + symbol)
        for count, before in [(30, None), (80, None),
                              (30, int(datetime(2010, 5, 4, tzinfo=UTC).timestamp() * 1000))]:
            request = {'instrument': ident, 'series_kind': 'provider', 'timeframe': 'D1',
                       'limit': count, 'firstDataRequest': before is None}
            if before is not None:
                request['before'] = before
            started = time.monotonic()
            page = call('/api/charts/data', request)
            assert_bars(page, count)
            assert page['adjustment'] == 'qfq'
            warnings = page['source_warnings']
            assert len(warnings) == expected_bad, (symbol, len(warnings))
            if symbol == '00700':
                assert {w['source_label'] for w in warnings} == {'2006-06-13', '2009-01-01'}
                assert next(w for w in warnings if w['source_label'] == '2006-06-13')['record']['low'] == '2.8475'
            listing = call('/api/market-data/center/platform', params={
                'source': 'akshare', 'query': symbol, 'page_size': 100})
            entry = next(r for r in listing['items'] if r['id'] == ident)
            assert '异常' in entry['quality_note'] and entry['adjustment'] == 'qfq'
            report['legacy_hk'].append({'symbol': symbol, 'before': before, 'requested': count,
                'rows': len(page['bars']), 'adjustment': page['adjustment'], 'warnings': warnings,
                'seconds': round(time.monotonic() - started, 3)})
            output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
            print(json.dumps({'symbol': symbol, 'count': count, 'historical': before is not None,
                              'excluded': len(warnings)}), flush=True)
    cases = [
        ('SINA-NATIVE:SZSE:000001', 'H1', 'none'),
        ('TENCENT-NATIVE:SZSE:000001', 'MN', 'none'),
        ('TENCENT-NATIVE:HKEX:02318', 'MN', 'none'),
        (stable_id('SZSE:000001'), 'D1', 'qfq'),
        ('TENCENT:SZSE:000001', 'D1', 'qfq'),
        *[(stable_id('SHFE:RB0'), frame, 'none') for frame in ['M1', 'M5', 'M15', 'M30', 'H1', 'D1']],
    ]
    for ident, frame, adjustment in cases:
        page = call('/api/charts/data', {'instrument': ident, 'series_kind': 'provider',
                    'timeframe': frame, 'limit': 30, 'firstDataRequest': True})
        assert_bars(page, 30)
        assert page['adjustment'] == adjustment
        report['regressions'].append({'id': ident, 'frame': frame, 'rows': 30, 'adjustment': adjustment})
    health = call('/api/health')
    report['runtime'] = {group: [{key: row.get(key) for key in ['role', 'state', 'error_type']}
        for row in health[group]] for group in ['market_runtime', 'data_runtime', 'notification_runtime']}
    assert all(row['state'] in ['idle', 'running', 'waiting_input'] and not row['error_type']
               for group in report['runtime'].values() for row in group)
    report['ready'] = call('/readyz')['status']
    assert report['ready'] == 'ready'
    report['passed'] = True
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'passed': True, 'hk_cases': len(report['legacy_hk']),
                      'regressions': len(report['regressions']), 'ready': report['ready']}))
