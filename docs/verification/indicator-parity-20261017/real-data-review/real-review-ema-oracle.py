"""Independent full-origin SMA-seeded EMA against captured native values."""
import json
import math
from pathlib import Path

directory = Path('/tmp/mw-issue74-20261017/real-data-review')
data = json.loads((directory / '16-real-eurusd-ema500-source.json').read_text())
target, source = data['target'], data['source']
operation = json.loads((directory / '15-xauusd-to-eurusd.json').read_text())
native_study = next(study for study in operation['result']['studies'] if study['name'] == 'EMA')
assert native_study['commit']['identity'] == target['commit']['identity']
assert native_study['commit']['displaySnapshot'] == target['commit']['displaySnapshot']
assert native_study['commit']['inputRevision'] == target['commit']['inputRevision']
# The original exploratory each callback incorrectly retained row.value from an
# array. Use the independently retained last() sample from the same exact
# identity, provider snapshot and revision; the browser generation advanced.
native = [native_study['nativeLast']]
assert source['status'] == 200
assert source['page']['provider_snapshot_id'] == target['commit']['displaySnapshot']
assert str(source['page']['cache_revision']) == str(target['commit']['inputRevision'])
origin = target['commit']['identity']['calculationStart']
rows = sorted((row for row in source['page']['bars'] if row['start'] >= origin),
              key=lambda row: row['start'])
assert rows[0]['start'] == origin
assert len({row['start'] for row in rows}) == len(rows)
period, seed, current, expected = 500, [], None, {}
for row in rows:
    close = float(row['close'])
    if current is None:
        seed.append(close)
        if len(seed) == period:
            current = math.fsum(seed) / period
    else:
        current += (close - current) * (2 / (period + 1))
    expected[row.get('chart_time', row['start']) / 1000] = current
errors = []
for row in native:
    assert row[0] in expected, ('native time missing from fixed-origin source', row[0])
    wanted = expected[row[0]]
    if wanted is None:
        assert row[1] is None
    else:
        assert row[1] is not None
        errors.append(abs(wanted - row[1]))
assert errors and max(errors) < 1e-12
result = dict(passed=True, source='real Dukascopy EUR/USD H4; exact provider snapshot/revision',
              origin=origin, inputRows=len(rows), nativeRows=len(native),
              comparedFinite=len(errors), maxAbsoluteError=max(errors), tolerance=1e-12,
              nativeGeneration=native_study['commit']['generation'],
              sourceCaptureGeneration=target['commit']['generation'],
              limits='EMA500 final native point only; no full visible-series or other-indicator numeric oracle claim')
(directory / '16-real-eurusd-ema500-oracle.json').write_text(json.dumps(result, indent=2))
print(json.dumps(result))
