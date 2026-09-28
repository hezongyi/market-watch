"""Read-only diagnostic: compare locally aggregated M1 with provider daily OHLC."""
import argparse
import json
from datetime import datetime, UTC
from decimal import Decimal
import httpx
from sqlalchemy import select
from alerts.config import settings
from alerts.storage import transaction, Bar, ms

parser = argparse.ArgumentParser()
parser.add_argument('--instrument', choices=['EURUSD', 'XAUUSD'], default='EURUSD')
parser.add_argument('--start', default='2026-09-24T21:00:00+00:00')
parser.add_argument('--end', default='2026-09-25T21:00:00+00:00')
args = parser.parse_args()
left = datetime.fromisoformat(args.start.replace('Z', '+00:00'))
right = datetime.fromisoformat(args.end.replace('Z', '+00:00'))
if left.tzinfo is None or right.tzinfo is None or right <= left:
    parser.error('Use increasing timezone-aware boundaries')
symbol = {'EURUSD': 'EUR_USD', 'XAUUSD': 'XAU_USD'}[args.instrument]
with transaction() as db:
    rows = db.scalars(select(Bar).where(Bar.instrument_id == args.instrument, Bar.timeframe == 'M1',
        Bar.start >= ms(left), Bar.start < ms(right)).order_by(Bar.start)).all()
    if not rows:
        raise RuntimeError('Import diagnostic interval first')
    local = {'o': rows[0].open, 'h': max(r.high for r in rows), 'l': min(r.low for r in rows), 'c': rows[-1].close}
with httpx.Client(proxy=settings.oanda_proxy or None, timeout=20, trust_env=False) as client:
    response = client.get(f'https://api-fxpractice.oanda.com/v3/instruments/{symbol}/candles',
        headers={'Authorization': 'Bearer ' + settings.oanda_token},
        params={'granularity': 'D', 'price': 'B', 'smooth': 'false', 'dailyAlignment': 17,
                'alignmentTimezone': 'America/New_York', 'from': left.isoformat(), 'to': right.isoformat()})
    response.raise_for_status()
    bars = response.json()['candles']
    if len(bars) != 1 or not bars[0]['complete']:
        raise RuntimeError('Unexpected daily reference range')
    reference = bars[0]
    result = {'instrument': args.instrument, 'start': left.isoformat(), 'end': right.isoformat(),
              'minute_count': len(rows), 'reference_time': reference['time'],
              'local': {k: str(v) for k,v in local.items()}, 'reference': reference['bid'],
              'equal': all(local[k] == Decimal(reference['bid'][k]) for k in local)}
    print(json.dumps(result, indent=2))
