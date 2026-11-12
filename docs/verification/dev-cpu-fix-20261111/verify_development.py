"""Read development services; never send test notifications or refresh catalogs."""
import importlib.util
import json
import ssl
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx

repo = Path(__file__).resolve().parents[3]
state = Path.home() / '.local/share/market-watch-dev'
credentials = json.loads((state / 'credentials.json').read_text())
context = ssl.create_default_context(cafile=credentials['ca_file'])
spec = importlib.util.spec_from_file_location('smoke', repo / 'deploy/ubuntu/development_smoke.py')
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)
smoke.csrf = smoke.call('/api/login', {'password': credentials['login_password']})['csrf']
result = {'ready': smoke.call('/readyz')['status']}
health = smoke.call('/api/health')
result['runtime'] = {key: [{'role': row['role'], 'state': row['state'],
                          'error': row.get('error_type')} for row in health[key]]
                     for key in ('market_runtime', 'data_runtime', 'notification_runtime')}
assert all(row['state'] not in ('missing', 'stale', 'degraded', 'failed') and not row['error']
           for rows in result['runtime'].values() for row in rows)
probes = [('oanda', 'EURUSD', 'H1'), ('binance', 'BTCUSDT', 'H1'),
          ('dukascopy', 'EURUSD', 'H1'), ('yahoo', 'SPY', 'D1'),
          ('akshare', '000001', 'D1'), ('fxcm', 'EURUSD', 'H1')]
def source_probe(probe):
    try:
        return smoke.source_read(*probe)
    except Exception as error:
        return {'source': probe[0], 'status': type(error).__name__,
                'http_status': getattr(error, 'code', None)}
if '--transport-only' not in sys.argv[2:]:
    with ThreadPoolExecutor(max_workers=3) as pool:
        result['sources'] = list(pool.map(source_probe, probes))
Path(sys.argv[1]).write_text(json.dumps(result, ensure_ascii=False, indent=2))
with httpx.Client(base_url=credentials['base_url'], verify=context, timeout=30) as client:
    client.post('/api/login', json={'password': credentials['login_password']}).raise_for_status()
    cursor = client.get('/api/notification-center/events?limit=1').json()['after']
    for path in ('/api/events', '/api/notification-center/stream'):
        params = {'after': cursor} if 'notification-center' in path else None
        with client.stream('GET', path, params=params) as response:
            response.raise_for_status()
            assert 'text/event-stream' in response.headers['content-type']
            first = next(line for line in response.iter_lines() if line)
            assert first.startswith(('event:', ':', 'data:', 'id:', 'retry:'))
            result[path] = True
    token = (state / 'mcp.token').read_text().strip()
    headers = {'Authorization': 'Bearer ' + token,
               'Accept': 'application/json, text/event-stream'}
    def rpc(method, params, ident):
        response = client.post('/mcp', headers=headers,
            json={'jsonrpc': '2.0', 'id': ident, 'method': method, 'params': params})
        response.raise_for_status()
        if response.headers.get('mcp-session-id'):
            headers['mcp-session-id'] = response.headers['mcp-session-id']
        payload = (response.json() if 'application/json' in response.headers.get('content-type', '')
                   else json.loads(next(line[6:] for line in response.text.splitlines()
                                        if line.startswith('data: '))))
        assert 'error' not in payload, 'MCP RPC failed'
        return payload['result']
    initialized = rpc('initialize', {'protocolVersion': '2025-03-26', 'capabilities': {},
                      'clientInfo': {'name': 'cpu-fix-verification', 'version': '1'}}, 1)
    headers['MCP-Protocol-Version'] = initialized['protocolVersion']
    client.post('/mcp', headers=headers,
                json={'jsonrpc': '2.0', 'method': 'notifications/initialized'}).raise_for_status()
    result['mcp_tools'] = len(rpc('tools/list', {}, 2)['tools'])
    assert result['mcp_tools'] >= 42
with httpx.Client(verify=context) as client:
    base = credentials['base_url'].rsplit(':', 1)[0] + ':18444'
    result['ntfy'] = client.get(base + '/v1/health').json()['healthy']
    assert result['ntfy']
Path(sys.argv[1]).write_text(json.dumps(result, ensure_ascii=False, indent=2))
print(json.dumps(result, ensure_ascii=False))
assert all(row['status'] == 'ok' for row in result.get('sources', [])), result.get('sources')
