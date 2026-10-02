"""Finite real-native PG preparation in the named isolated acceptance container.

Run inside that API image, before browser timing starts. This is never a frontend
preload mechanism and changes no product endpoint or foreground deadline.
"""
import argparse
import time

from sqlalchemy.engine import make_url

from alerts import provider_cache, provider_chart
from alerts.config import settings
from alerts.storage import now_ms

parser = argparse.ArgumentParser()
parser.add_argument('instrument')
parser.add_argument('--timeframe', default='M5')
parser.add_argument('--count', type=int, default=4000)
args = parser.parse_args()
url = make_url(settings.database_url)
assert url.host == 'market-watch-native-history-pg' and url.database == 'market_watch_native_history'
assert 1 <= args.count <= 10000
meta = provider_chart.metadata(args.instrument)
page = provider_cache.read(meta, args.timeframe, (now_ms() // 1000 + 1) * 1000,
                           args.count, latest=True, deadline=time.monotonic() + 30)
print('Prepared native PG bars:', len(page['bars']), 'cache_hit:', page['cache_hit'])
provider_chart.close_clients()
