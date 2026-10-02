"""Finite real-native PG preparation in the named isolated acceptance container.

Run inside that API image, before browser timing starts. This is never a frontend
preload mechanism and changes no product endpoint or foreground deadline.
"""
import argparse
import json
import time

from alerts import provider_cache, provider_chart
from alerts.config import settings
from alerts.storage import now_ms
from sqlalchemy.engine import make_url

parser = argparse.ArgumentParser()
parser.add_argument('instrument')
parser.add_argument('--timeframe', default='M5')
parser.add_argument('--count', type=int, default=4000)
args = parser.parse_args()
url = make_url(settings.database_url)
assert url.host == 'market-watch-native-history-pg' and url.database == 'market_watch_native_history'
assert 1 <= args.count <= 20000
meta = provider_chart.metadata(args.instrument)
deadline = time.monotonic() + 30
page = provider_cache.read(meta, args.timeframe, (now_ms() // 1000 + 1) * 1000,
                           args.count, latest=True, deadline=deadline)
# A large preparation may outlive tail freshness. Complete a finite required
# tail read within the same preparation budget before measured navigation.
tail = provider_cache.read(meta, args.timeframe, (now_ms() // 1000 + 1) * 1000,
                           min(args.count, 200), latest=True, deadline=deadline)
bars = page['bars']
print(json.dumps({'prepared_native_pg_bars': len(bars), 'cache_hit': page['cache_hit'],
                  'tail_read_cache_hit': tail['cache_hit'],
                  'target_10000': bars[-10001]['chart_time'] if len(bars) > 10000 else None,
                  'target_10165': bars[-10166]['chart_time'] if len(bars) > 10165 else None}))
provider_chart.close_clients()
