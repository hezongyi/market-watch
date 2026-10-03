"""Prepare finite real provider history only in the dedicated acceptance DB."""
import argparse
import json
import time

from alerts import provider_cache, provider_chart
from alerts.config import settings
from alerts.storage import now_ms
from sqlalchemy.engine import make_url

parser = argparse.ArgumentParser()
parser.add_argument('instrument', default='EURUSD', nargs='?')
parser.add_argument('--timeframe', default='M5')
parser.add_argument('--count', type=int, default=4000)
args = parser.parse_args()
url = make_url(settings.database_url)
assert url.host == 'pg' and url.database == 'viewport'
assert settings.database_application_name == 'mw-viewport-acceptance'
assert not settings.delivery_enabled and 1 <= args.count <= 10000
meta = provider_chart.metadata(args.instrument)
started = time.monotonic()
page = provider_cache.read(meta, args.timeframe, (now_ms() // 1000 + 1) * 1000,
                           args.count, latest=True, deadline=started + 90)
print(json.dumps({'instrument': args.instrument, 'timeframe': args.timeframe,
                  'count': len(page['bars']), 'cache_hit': page['cache_hit'],
                  'first': page['bars'][0]['chart_time'],
                  'last': page['bars'][-1]['chart_time'],
                  'seconds': round(time.monotonic() - started, 3)}))
provider_chart.close_clients()
