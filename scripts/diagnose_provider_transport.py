"""Read-only local HTTPX comparison; output contains timings, never credentials."""

import argparse
import json
import time
from pathlib import Path

import httpx


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    parser.add_argument('--rounds', type=int, default=4)
    parser.add_argument('--schemes', default='http,socks5h')
    parser.add_argument('--http-versions', default='1',
                        help='Comma-separated 1,2; HTTP/2 requires h2 in the diagnostic environment')
    parser.add_argument('--sources', default='binance,oanda',
                        help='Comma-separated sources; diagnostic only, no runtime configuration change')
    parser.add_argument('--oanda-symbol', default='EUR_USD')
    parser.add_argument('--end-ms', type=int,
                        help='Optional fixed historical endpoint for matching a slow native request')
    args = parser.parse_args()
    config = dict(line.split('=', 1) for line in
                  Path('/tmp/mw-dual-acceptance/api.env').read_text().splitlines()
                  if '=' in line and not line.startswith('#'))
    token = config['ALERTS_OANDA_TOKEN']
    end = args.end_ms or int(time.time() * 1000)
    targets = {
        'binance': ('https://data-api.binance.vision/api/v3/klines',
                    {'symbol': 'BTCUSDT', 'interval': '1m', 'limit': 200, 'endTime': end}, {}),
        'oanda': (f'https://api-fxpractice.oanda.com/v3/instruments/{args.oanda_symbol}/candles',
                  {'granularity': 'M1', 'price': 'B', 'count': 200, 'to': str(end / 1000),
                   'smooth': 'false', 'dailyAlignment': 17,
                   'alignmentTimezone': 'America/New_York', 'weeklyAlignment': 'Sunday'},
                  {'Authorization': 'Bearer ' + token, 'Accept-Datetime-Format': 'UNIX'}),
    }
    records = []
    for round_number in range(args.rounds):
        for source, (url, params, headers) in targets.items():
            if source not in args.sources.split(','):
                continue
            schemes = [(scheme, version) for scheme in args.schemes.split(',')
                       for version in args.http_versions.split(',')]
            if round_number % 2:
                schemes.reverse()
            for scheme, version in schemes:
                proxy = None if scheme == 'direct' else scheme + '://192.168.7.33:7890'
                with httpx.Client(proxy=proxy, trust_env=False, http2=version == '2',
                                  timeout=4, limits=httpx.Limits(max_connections=4,
                                  max_keepalive_connections=2, keepalive_expiry=60)) as client:
                    for repeat in range(2):
                        phases, started_phases = {}, {}
                        def trace(name, info):
                            stage, _, event = name.rpartition('.')
                            if event == 'started':
                                started_phases[stage] = time.monotonic()
                            elif event in ('complete', 'failed') and stage in started_phases:
                                phases[stage] = round((time.monotonic() - started_phases.pop(stage)) * 1000, 2)
                        began = time.monotonic()
                        record = {'round': round_number, 'source': source, 'scheme': scheme,
                                  'http2_enabled': version == '2', 'repeat': repeat, 'phases_ms': phases}
                        try:
                            response = client.get(url, params=params, headers=headers,
                                                  extensions={'trace': trace})
                            record['status'] = response.status_code
                            record['negotiated_http_version'] = response.http_version
                            if response.status_code == 200:
                                payload = response.json()
                                record['bars'] = len(payload['candles'] if source == 'oanda' else payload)
                        except httpx.HTTPError as error:
                            record['error_type'] = type(error).__name__
                        record['elapsed_ms'] = round((time.monotonic() - began) * 1000, 2)
                        record['new_connection'] = any('connect_tcp' in name for name in phases)
                        records.append(record)
                        Path(args.output).write_text(json.dumps({'records': records}, indent=2))
                        print(json.dumps(record), flush=True)


if __name__ == '__main__':
    main()
