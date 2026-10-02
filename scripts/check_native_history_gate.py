"""Fast red-capable check of the fixed formal native-history latency cohort."""
import argparse
import hashlib
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('path', nargs='?', default='docs/verification/native-history/implementation/browser-performance.json')
parser.add_argument('--acceptance-decision', help='Explicit recorded user decision for this fixed cohort')
args = parser.parse_args()
report_path = Path(args.path)
report = json.loads(report_path.read_text())
accepted_groups = set()
if args.acceptance_decision:
    decision = json.loads(Path(args.acceptance_decision).read_text())
    if decision.get('report_sha256') != hashlib.sha256(report_path.read_bytes()).hexdigest():
        parser.error('Acceptance decision does not match this fixed report')
    if decision.get('status') != 'accepted_by_user' or not decision.get('user_instruction'):
        parser.error('No explicit user acceptance recorded')
    accepted_groups = {tuple(group) for group in decision.get('accepted_groups', [])}
    if not accepted_groups <= {('MWP:BTCUSDT', 'cold'), ('MWP:BTCUSDT', 'pg')}:
        parser.error('Only the explicitly accepted Binance latency groups are covered')
passed = True
for symbol in ['MWP:OANDA:AUD_CAD', 'MWP:BTCUSDT']:
    for scene, metric, threshold in [('cold', 'native_ms', 3000), ('pg', 'native_ms', 1000)]:
        rows = [r for r in report['records'] if r['enabled'] and r['symbol'] == symbol and r['scenario'] == scene]
        def valid(row):
            http = row.get('http', [])
            if row.get('error') or row.get('errors') or not http or any(h['status'] != 200 for h in http):
                return False
            if scene == 'pg' and not all(h.get('cache_hit') is True and not h.get('attempts') for h in http):
                return False
            return row.get(metric, float('inf')) < threshold
        successes = sum(valid(row) for row in rows)
        hits = sum(bool(r.get('http')) and all(h.get('cache_hit') is True for h in r['http']) for r in rows)
        green = len(rows) == 10 and successes >= 8
        print(symbol, scene, f'{successes}/{len(rows)} < {threshold}ms',
              f'actual demand-cache hits={hits}', 'PASS' if green else 'FAIL')
        accepted = (symbol, scene) in accepted_groups and len(rows) == 10
        if accepted and not green:
            print('  ACCEPTED BY USER; numeric gate remains failed, original samples retained')
        passed &= green or accepted
raise SystemExit(0 if passed else 1)
