"""Serial requests to the isolated running API; no cache reset or managed writes."""

import json
import argparse
import time
from pathlib import Path

import httpx


def main():
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', default=str(root / 'docs/verification/provider-cache/runtime-serial-http-timings.json'))
    parser.add_argument('--anchor', type=int, default=1788206400000)
    args = parser.parse_args()
    output = Path(args.output)
    password = json.loads((root.parent / 'market-watch/artifacts/local-credentials.json').read_text())['password']
    records = []
    with httpx.Client(base_url='https://localhost:15453', verify=False, timeout=30,
                      trust_env=False) as client:
        login = client.post('/api/login', json={'password': password})
        login.raise_for_status()
        headers = {'X-CSRF-Token': login.json()['csrf']}
        # Distinct historical windows exercise upstream without unrelated chart activity.
        for repeat in range(16):
            source = 'binance' if repeat % 2 == 0 else 'oanda'
            body = {'instrument': 'BTCUSDT' if source == 'binance' else 'OANDA:AUD_CAD',
                    'series_kind': 'provider', 'timeframe': 'M1', 'limit': 200,
                    'countBack': 200, 'indicators': [], 'track_history': False,
                    'before': args.anchor - repeat * 86400000}
            began = time.monotonic()
            response = client.post('/api/charts/data', headers=headers, json=body)
            payload = response.json()
            record = {'repeat': repeat, 'source': source, 'status': response.status_code,
                      'elapsed_ms': round((time.monotonic() - began) * 1000, 2),
                      'count': len(payload.get('bars', [])), 'cache_hit': payload.get('cache_hit'),
                      'timings_ms': payload.get('timings_ms')}
            records.append(record)
            output.write_text(json.dumps({'records': records}, indent=2))
            print(json.dumps(record), flush=True)


if __name__ == '__main__':
    main()
