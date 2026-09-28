"""Compare OANDA M1 and S5 observations for one historical interval; no trading."""
import argparse
import json
from datetime import datetime

import httpx
from alerts.config import settings

parser = argparse.ArgumentParser()
parser.add_argument('--instrument', choices=['EUR_USD', 'XAU_USD'], required=True)
parser.add_argument('--start', required=True)
parser.add_argument('--end', required=True)
args = parser.parse_args()
start = datetime.fromisoformat(args.start.replace('Z', '+00:00'))
end = datetime.fromisoformat(args.end.replace('Z', '+00:00'))
if start.tzinfo is None or end.tzinfo is None or not 0 < (end-start).total_seconds() <= 3600:
    parser.error('Use explicit timezones and a range of at most one hour')
observations = {}
with httpx.Client(proxy=settings.oanda_proxy or None, timeout=20, trust_env=False) as client:
    for frame in ['M1', 'S5']:
        response = client.get(
            f'https://api-fxpractice.oanda.com/v3/instruments/{args.instrument}/candles',
            headers={'Authorization': 'Bearer ' + settings.oanda_token},
            params={'granularity': frame, 'price': 'B', 'from': args.start, 'to': args.end},
        )
        response.raise_for_status()
        observations[frame] = response.json()['candles']
minutes = lambda frame: {c['time'][:16] for c in observations[frame] if c['complete']}
print(json.dumps({
    'instrument': args.instrument, 'start': args.start, 'end': args.end,
    'counts': {key: len(value) for key, value in observations.items()},
    'minutes_with_S5_but_no_M1': sorted(minutes('S5') - minutes('M1')),
    'M1': [{'time': c['time'], 'volume': c['volume'], 'complete': c['complete']} for c in observations['M1']],
}, indent=2))
