"""Correlate native HTTP phases with read-only Mihomo connection observations.

Never changes proxy selectors/rules, never writes managed market data, and never
persists credentials, request headers, or unrelated connection metadata.
"""

import argparse
import json
import threading
import time
from pathlib import Path

import httpx


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    parser.add_argument('--rounds', type=int, default=8)
    parser.add_argument('--controller', default='http://192.168.7.33:9090')
    parser.add_argument('--controller-logs', action='store_true',
                        help='Read only relevant controller info logs; requires diagnostic websockets package')
    args = parser.parse_args()
    config = dict(line.split('=', 1) for line in
                  Path('/tmp/mw-dual-acceptance/api.env').read_text().splitlines()
                  if '=' in line and not line.startswith('#'))
    targets = {
        'oanda': ('api-fxpractice.oanda.com', '/v3/instruments/AUD_CAD/candles',
                  {'granularity': 'M1', 'price': 'B', 'count': 200,
                   'to': '1784937600', 'smooth': 'false', 'dailyAlignment': 17,
                   'alignmentTimezone': 'America/New_York', 'weeklyAlignment': 'Sunday'},
                  {'Authorization': 'Bearer ' + config['ALERTS_OANDA_TOKEN'],
                   'Accept-Datetime-Format': 'UNIX'}),
        'binance': ('data-api.binance.vision', '/api/v3/klines',
                    {'symbol': 'BTCUSDT', 'interval': '1m', 'limit': 200,
                     'endTime': 1784937600000}, {}),
    }
    evidence = {'read_only': True, 'controller': args.controller,
                'scope': '200 native historical bars; local source port matches Mihomo metadata.sourcePort',
                'records': [], 'controller_logs': [], 'controller_log_errors': []}
    output = Path(args.output)
    log_stop, log_thread = threading.Event(), None
    if args.controller_logs:
        def read_logs():
            from websockets.sync.client import connect
            uri = args.controller.replace('http://', 'ws://').replace('https://', 'wss://')
            try:
                with connect(uri + '/logs?level=info', proxy=None,
                             open_timeout=2, close_timeout=1) as stream:
                    while not log_stop.is_set():
                        try:
                            entry = json.loads(stream.recv(timeout=0.25))
                        except TimeoutError:
                            continue
                        message = entry.get('payload', '')
                        if any(target[0] in message for target in targets.values()):
                            evidence['controller_logs'].append({
                                'observed_at_ms': round(time.time() * 1000),
                                'level': entry.get('type'), 'message': message,
                            })
            except Exception as error:
                evidence['controller_log_errors'].append(type(error).__name__)
        log_thread = threading.Thread(target=read_logs, daemon=True)
        log_thread.start()
    for round_number in range(args.rounds):
        sources = list(targets)
        if round_number % 2:
            sources.reverse()
        for source in sources:
            host, path, params, headers = targets[source]
            stop = threading.Event()
            local_port = [None]
            observations, observer_errors = [], []
            origin = time.monotonic()

            def observe():
                with httpx.Client(base_url=args.controller, timeout=1, trust_env=False) as controller:
                    while not stop.is_set():
                        if local_port[0] is not None:
                            try:
                                response = controller.get('/connections')
                                response.raise_for_status()
                                for row in response.json().get('connections', []):
                                    meta = row.get('metadata', {})
                                    if meta.get('host') != host or str(meta.get('sourcePort')) != str(local_port[0]):
                                        continue
                                    safe = {'id': row['id'], 'chains': row.get('chains'),
                                            'rule': row.get('rule'), 'start': row.get('start'),
                                            'upload': row.get('upload'), 'download': row.get('download')}
                                    if not observations or observations[-1]['connection'] != safe:
                                        observations.append({'at_ms': round((time.monotonic() - origin) * 1000, 2),
                                                             'connection': safe})
                            except (httpx.HTTPError, ValueError) as error:
                                observer_errors.append(type(error).__name__)
                        stop.wait(0.1)

            observer = threading.Thread(target=observe, daemon=True)
            observer.start()
            try:
                with httpx.Client(proxy='http://192.168.7.33:7890', trust_env=False,
                                  timeout=4, limits=httpx.Limits(max_connections=1)) as client:
                    for repeat in range(3):
                        phases, began = [], time.monotonic()

                        def trace(name, info):
                            phases.append({'name': name, 'at_ms': round((time.monotonic() - origin) * 1000, 2)})
                            if name == 'connection.connect_tcp.complete':
                                local_port[0] = info['return_value'].get_extra_info('client_addr')[1]

                        record = {'round': round_number, 'source': source, 'repeat': repeat,
                                  'started_at_ms': round((began - origin) * 1000, 2), 'phases': phases}
                        try:
                            response = client.get('https://' + host + path, params=params,
                                                  headers=headers, extensions={'trace': trace})
                            record['status'] = response.status_code
                            if response.status_code == 200:
                                payload = response.json()
                                record['bars'] = len(payload['candles'] if source == 'oanda' else payload)
                        except httpx.HTTPError as error:
                            record['error_type'] = type(error).__name__
                        record['elapsed_ms'] = round((time.monotonic() - began) * 1000, 2)
                        record['local_source_port'] = local_port[0]
                        time.sleep(0.15)
                        record['proxy_observations'] = list(observations)
                        record['observer_errors'] = list(observer_errors)
                        evidence['records'].append(record)
                        output.write_text(json.dumps(evidence, indent=2, ensure_ascii=False))
                        print(json.dumps({key: value for key, value in record.items()
                                          if key not in ('phases', 'proxy_observations')}, ensure_ascii=False), flush=True)
            finally:
                stop.set()
                observer.join(timeout=2)
    log_stop.set()
    if log_thread:
        log_thread.join(timeout=3)
    output.write_text(json.dumps(evidence, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
