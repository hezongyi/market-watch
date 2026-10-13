"""Synthetic published-input mutations only in this task's Ubuntu acceptance DB."""
import os
import sys
from sqlalchemy.engine import make_url
from alerts.config import settings
from alerts.storage import ChartHistoryPlan, ChartPublication, ChartPublishedBar, transaction, now_ms

url = make_url(settings.database_url)
if (os.environ.get('MW_PENDING_ACCEPTANCE_TASK') != 'mw-pending-fixes-20261013'
        or url.host != 'pg' or url.database != 'production_ux_acceptance'
        or settings.delivery_enabled or settings.oanda_token or settings.yahoo_enabled):
    raise RuntimeError('Requires task-local synthetic acceptance configuration')
action=sys.argv[1]
if action not in {'seed','tail','prefix','reset'}:
    raise ValueError('Unknown fixture operation')
with transaction() as db:
    pub = db.get(ChartPublication, ('BTCUSDT', 'M1'))
    if action == 'seed':
        if pub:
            raise RuntimeError('Do not overwrite an existing published dataset')
        end = now_ms() // 60000 * 60000 + 60000
        start = end - 1200 * 60000
        db.add(ChartHistoryPlan(instrument_id='BTCUSDT', target_start=start, target_end=end-60000,
            status='complete', cursor=start, realtime_enabled=False, realtime_end=end-60000))
        db.add(ChartPublication(instrument_id='BTCUSDT', timeframe='M1', start=start,
            end=end, complete_count=1199, initialized=True, revision=1))
        for at in range(start, end, 60000):
            complete = at + 60000 < end
            payload = dict(start=at, end=at+60000, chart_time=at, open='10', high='11', low='9',
                close='10', complete=complete, volume=None, volume_complete=False)
            db.add(ChartPublishedBar(instrument_id='BTCUSDT', timeframe='M1', start=at,
                end=at+60000, complete=complete, payload=payload, revision=1))
    else:
        if not pub or pub.complete_count != 1199:
            raise RuntimeError('Requires this task synthetic publication')
        times = (pub.start, pub.end-60000) if action == 'reset' else (
            pub.end-60000 if action == 'tail' else int(sys.argv[2]),)
        for at in times:
            if not pub.start <= at < pub.end:
                raise RuntimeError('Outside synthetic publication')
            row = db.get(ChartPublishedBar, ('BTCUSDT', 'M1', at))
            row.payload = {**row.payload, 'high':'11' if action=='reset' else '1001',
                'close':'10' if action=='reset' else '20' if action=='tail' else '1000'}
            row.revision += 1
        pub.revision += 1
        pub.updated_at = now_ms()
print('Task-local synthetic published inputs updated; no supplier/coverage evidence')
