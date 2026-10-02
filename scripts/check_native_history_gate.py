"""Fast red-capable check of the fixed formal native-history latency cohort."""
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('path', nargs='?', default='docs/verification/native-history/implementation/browser-performance.json')
args = parser.parse_args()
report = json.loads(Path(args.path).read_text())
passed = True
for symbol in ['MWP:OANDA:AUD_CAD', 'MWP:BTCUSDT']:
    for scene, metric, threshold in [('cold', 'ui_ms', 3000), ('pg', 'native_ms', 1000)]:
        rows = [r for r in report['records'] if r['enabled'] and r['symbol'] == symbol and r['scenario'] == scene]
        successes = sum(not r.get('error') and r.get(metric, float('inf')) < threshold for r in rows)
        green = len(rows) == 10 and successes >= 8
        print(symbol, scene, f'{successes}/{len(rows)} < {threshold}ms', 'PASS' if green else 'FAIL')
        passed &= green
raise SystemExit(0 if passed else 1)
