"""Read-only regression proof; imports the reviewed worktree, no database or network."""
import json
from datetime import datetime
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch

from alerts import composite_quotes, history_artifacts
from alerts.quote_presentation import fixed_snapshot


def stamp(value):
    return int(datetime.fromisoformat(value).timestamp() * 1000)


start = stamp('2026-01-05T22:00:00+00:00')
end = stamp('2026-01-06T22:00:00+00:00')
observed_at = stamp('2026-01-07T12:00:00+00:00')
instrument = SimpleNamespace(id='MD:review-fixture', calendar='ny17', calendar_profile={})
version = SimpleNamespace(id='fixed-review-fixture', start=start, end=end + 86400000)
dataset = SimpleNamespace(volume_kind='price_count', volume_unit='quotes')
# Exactly one source-confirmed minute at the beginning of a full daily bucket.
# Every subsequent minute, including the close, is missing.
state = {'start': start, 'end': end, 'open': '1.10', 'high': '1.10',
         'low': '1.10', 'close': '1.10', 'volume': '1', 'volume_present': True,
         'observed': 1, 'source_confirmed': True, 'conflict': False}
previous = history_artifacts._finish(state, instrument, version, dataset)
latest = {'start': observed_at, 'end': observed_at + 60000, 'close': '1.12'}


def fixed_page(db, ident, frame, **kwargs):
    return {'bars': [latest] if frame == 'M1' else [previous]}


with patch.object(history_artifacts, 'chart_page', fixed_page):
    fixed = fixed_snapshot(None, version.id, {'frames': ['M1'], 'calendar': 'ny17'})

engine_identity = object()
db = SimpleNamespace(get_bind=lambda: engine_identity)
composite = SimpleNamespace(id='composite-review-fixture')
revision = SimpleNamespace(id='revision-review-fixture', rules={'aggregation_calendar': 'ny17'})
# Patch only I/O. Both readers receive the exact output of the real aggregator.
with patch.object(composite_quotes, '_previous_close_cache', {}), patch.object(
        composite_quotes, 'chart_page', lambda *args, **kwargs: {'bars': [previous]}):
    composite_close = composite_quotes.previous_close(db, composite, revision=revision,
        input_revision=0, observed_at=observed_at)

assert previous['observed_minutes'] == 1
assert previous['expected_minutes'] == 1440
assert previous['source_confirmed'] and previous['time_closed']
assert not previous['complete'] and not previous['coverage_complete']
assert fixed['prev_close_price'] == 1.10
assert composite_close == Decimal('1.10')
output = {
    'source': '/home/quant/repos/market-watch-composite-mapping-20261021',
    'reviewed_head': 'c4086d1f4c01c28afb519cc45e58f5c87b7e9d62',
    'scenario': 'Only the first minute of the prior daily bucket exists; its ending observations are missing.',
    'daily_bucket': {key: previous[key] for key in (
        'start', 'end', 'observed_minutes', 'expected_minutes', 'time_closed',
        'source_confirmed', 'complete', 'coverage_complete', 'close')},
    'fixed_snapshot': {key: fixed[key] for key in ('lp', 'prev_close_price', 'ch', 'chp')},
    'composite_previous_close': str(composite_close),
    'defect_reproduced': True,
}
print(json.dumps(output, indent=2))
