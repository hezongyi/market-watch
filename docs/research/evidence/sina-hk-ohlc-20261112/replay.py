"""Replay real Sina/AKShare HK qfq records through the existing strict parser.

Run from repository root: PYTHONPATH=backend python .../replay.py [strict]
Default proves exclusion feasibility; strict reproduces the historical failure.
No network, credentials, database writes or service changes.
"""

import json
import sys
from pathlib import Path

from alerts.history_mode_sources import dataset_identity
from alerts.provider_akshare import collection_identity, parse_records

root = Path(__file__).parent
fixture = json.loads((root / '00700-minimal.json').read_text())
source = collection_identity(dataset_identity('akshare', 'HKEX:00700', 'native_periods', 'none'), 'D1')
source = source.model_copy(update={'parameters': {**source.parameters, 'adjustment': 'qfq'}})
strict = 'strict' in sys.argv[1:]
warnings = None if strict else []
rows = parse_records(source, fixture['qfq'], start=0, end=1794528000000,
                     observed_at=1794528000000, invalid_records=warnings)
assert len(rows) == 2
assert len(warnings) == 2
original = {r['date']: r for r in fixture['qfq']}
assert all(all(getattr(row, key) == original[row.source_label][key]
               for key in ('open', 'high', 'low', 'close', 'volume')) for row in rows)
print(json.dumps({'valid_rows': len(rows), 'excluded_rows': len(warnings),
                  'valid_ohlcv_unchanged': True, 'warnings': warnings}, ensure_ascii=False))
