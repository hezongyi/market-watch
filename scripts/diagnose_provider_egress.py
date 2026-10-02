"""Bounded, serial provider reads with read-only route correlation; no database writes."""
import argparse
import json
import threading
import time
from pathlib import Path

import httpx


def check_stage_budget(evidence, budget_ms):
    """An upstream stage above 3s disproves a 3s screen budget; a pass does not prove it."""
    records = evidence['records']
    failures = [record for record in records if record.get('status') != 200 or record['elapsed_ms'] >= budget_ms]
    evidence['stage_budget_ms'] = budget_ms
    evidence['stage_budget_passed'] = bool(records) and not failures
    print(f"UPSTREAM STAGE BUDGET {'PASS' if evidence['stage_budget_passed'] else 'FAIL'}: "
          f"{len(records) - len(failures)}/{len(records)} requests returned 200 within {budget_ms:g}ms")
    for record in failures:
        print(json.dumps({key: record.get(key) for key in
                          ['source', 'repeat', 'status', 'error_type', 'elapsed_ms', 'source_port']}, ensure_ascii=False))
    print('This checks only the upstream request, not native boot, database work, or full first-screen acceptance.')
    return evidence['stage_budget_passed']


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output')
    parser.add_argument('--replay', type=Path, help='Read a saved egress trace without making network requests')
    parser.add_argument('--stage-budget-ms', type=float, default=3000)
    parser.add_argument('--oanda-reads', type=int, default=32)
    parser.add_argument('--binance-cold-reads', type=int, default=8)
    parser.add_argument('--controller-logs', action='store_true')
    args = parser.parse_args()
    if args.stage_budget_ms <= 0:
        parser.error('--stage-budget-ms must be positive')
    if args.replay:
        evidence = json.loads(args.replay.read_text())
        raise SystemExit(0 if check_stage_budget(evidence, args.stage_budget_ms) else 1)
    if not args.output:
        parser.error('--output is required for live reads')
    if min(args.oanda_reads, args.binance_cold_reads) < 0 or not 1 <= args.oanda_reads + args.binance_cold_reads <= 64:
        parser.error('choose 1 to 64 total reads with nonnegative source counts')
    config = dict(line.split('=', 1) for line in Path('/tmp/mw-dual-acceptance/api.env').read_text().splitlines()
                  if '=' in line and not line.startswith('#'))
    output = Path(args.output)
    evidence = {'read_only': True, 'serial': True, 'minimum_request_start_interval_seconds': 1,
                'records': [], 'observer_errors': [], 'matched_controller_logs': [], 'controller_log_errors': [],
                'scope': 'native historical 200-bar reads; exact host/source-port route match; no database/cache reset'}
    state = {'record': None, 'port': None, 'host': None}
    stop = threading.Event()

    def observe():
        with httpx.Client(base_url='http://192.168.7.33:9090', timeout=1, trust_env=False) as controller:
            while not stop.is_set():
                record, port, host = state['record'], state['port'], state['host']
                if record is not None and port is not None:
                    request_began = record.get('_began')
                    if request_began is None:
                        continue
                    try:
                        response = controller.get('/connections')
                        response.raise_for_status()
                        for row in response.json().get('connections', []):
                            meta = row.get('metadata', {})
                            if meta.get('host') == host and str(meta.get('sourcePort')) == str(port):
                                safe = {'id': row['id'], 'source_port': port, 'chains': row.get('chains', []),
                                        'start': row.get('start'), 'upload': row.get('upload'), 'download': row.get('download')}
                                observations = record['proxy_observations']
                                if not observations or observations[-1]['connection'] != safe:
                                    observations.append({'at_ms': round((time.monotonic()-request_began)*1000, 2), 'connection': safe})
                    except (httpx.HTTPError, ValueError) as error:
                        evidence['observer_errors'].append(type(error).__name__)
                stop.wait(0.15)

    watcher = threading.Thread(target=observe, daemon=True)
    watcher.start()
    controller_logs = []
    log_thread = None
    if args.controller_logs:
        def read_logs():
            from websockets.sync.client import connect
            try:
                with connect('ws://192.168.7.33:9090/logs?level=info', proxy=None, open_timeout=2, close_timeout=1) as stream:
                    while not stop.is_set():
                        try:
                            entry = json.loads(stream.recv(timeout=0.2))
                        except TimeoutError:
                            continue
                        message = entry.get('payload', '')
                        if 'api-fxpractice.oanda.com' in message or 'data-api.binance.vision' in message:
                            controller_logs.append({'observed_at_epoch_ms': round(time.time()*1000), 'message': message})
            except Exception as error:
                evidence['controller_log_errors'].append(type(error).__name__)
        log_thread = threading.Thread(target=read_logs, daemon=True)
        log_thread.start()
    prior_start = 0
    client = None
    try:
        for source, count in [('oanda', args.oanda_reads), ('binance', args.binance_cold_reads)]:
            state['host'] = 'api-fxpractice.oanda.com' if source == 'oanda' else 'data-api.binance.vision'
            if client is not None:
                client.close()
            client = None
            for repeat in range(count):
                if source == 'binance' or client is None:
                    if client is not None:
                        client.close()
                    client = httpx.Client(proxy='http://192.168.7.33:7890', timeout=4, trust_env=False,
                                          limits=httpx.Limits(max_connections=1, max_keepalive_connections=1, keepalive_expiry=60))
                    state['port'] = None
                time.sleep(max(0, prior_start + 1 - time.monotonic()))
                began = prior_start = time.monotonic()
                record = {'source': source, 'repeat': repeat, 'started_at_epoch_ms': round(time.time()*1000),
                          '_began': began, 'events': [], 'proxy_observations': []}
                state['record'] = record

                def trace(name, info):
                    record['events'].append({'name': name, 'at_ms': round((time.monotonic()-began)*1000, 2)})
                    if name == 'connection.connect_tcp.complete':
                        state['port'] = info['return_value'].get_extra_info('client_addr')[1]

                end_ms = 1784937600000 - repeat*86400000
                if source == 'oanda':
                    url = 'https://api-fxpractice.oanda.com/v3/instruments/AUD_CAD/candles'
                    params = {'granularity': 'M1', 'price': 'B', 'count': 200, 'to': str(end_ms/1000),
                              'smooth': 'false', 'dailyAlignment': 17, 'alignmentTimezone': 'America/New_York', 'weeklyAlignment': 'Sunday'}
                    headers = {'Authorization': 'Bearer '+config['ALERTS_OANDA_TOKEN'], 'Accept-Datetime-Format': 'UNIX'}
                else:
                    url = 'https://data-api.binance.vision/api/v3/klines'
                    params = {'symbol': 'BTCUSDT', 'interval': '1m', 'limit': 200, 'endTime': end_ms-1}
                    headers = {}
                try:
                    response = client.get(url, params=params, headers=headers, extensions={'trace': trace})
                    record['status'] = response.status_code
                    if response.status_code == 200:
                        payload = response.json()
                        record['bars'] = len(payload['candles'] if source == 'oanda' else payload)
                except httpx.HTTPError as error:
                    record['error_type'] = type(error).__name__
                    client.close()
                    client = None  # Never count subsequent poisoned-pool timeouts as independent network failures.
                record['elapsed_ms'] = round((time.monotonic()-began)*1000, 2)
                record['source_port'] = state['port']
                record['new_connection'] = any(e['name'] == 'connection.connect_tcp.started' for e in record['events'])
                record['confirmed_reuse'] = record.get('status') == 200 and not record['new_connection'] and any(
                    e['name'] == 'http11.receive_response_headers.complete' for e in record['events'])
                time.sleep(0.16)
                state['record'] = None
                record.pop('_began')
                evidence['records'].append(record)
                output.write_text(json.dumps(evidence, indent=2, ensure_ascii=False))
                print(json.dumps({k:v for k,v in record.items() if k not in ['events', 'proxy_observations']}, ensure_ascii=False), flush=True)
    finally:
        state['record'] = None
        stop.set()
        watcher.join(timeout=2)
        if log_thread is not None:
            log_thread.join(timeout=2)
        ports = {r['source_port'] for r in evidence['records'] if r.get('source_port') is not None}
        evidence['matched_controller_logs'] = [entry for entry in controller_logs if any(
            f':{port} --> ' in entry['message'] for port in ports)]
        if client is not None:
            client.close()
        output.write_text(json.dumps(evidence, indent=2, ensure_ascii=False))
    passed = check_stage_budget(evidence, args.stage_budget_ms)
    output.write_text(json.dumps(evidence, indent=2, ensure_ascii=False))
    raise SystemExit(0 if passed else 1)


if __name__ == '__main__':
    main()
