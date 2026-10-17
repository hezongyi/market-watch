"""Add a separate synthetic long-origin fixture; never reset an existing seed."""

import json
import math
from datetime import datetime, timezone
from decimal import Decimal

from alerts.config import settings
from alerts.history_artifacts import artifact_tick, request_artifacts
from alerts.history_versions import create_version, import_page
from alerts.market_contracts import CandleBatch, DatasetIdentity, MinuteRow, RequestResult
from alerts.market_datasets import register_dataset
from alerts.storage import HistoryArtifact, HistoryVersion, Preference, transaction
from sqlalchemy import select
from sqlalchemy.engine import make_url

MARKER = 'acceptance.indicator-parity-long.20261017'


def seed():
    url = make_url(settings.database_url)
    if (url.host != 'pg' or url.database != 'indicator_parity' or
            settings.database_application_name != 'mw-issue74-20261017' or
            settings.delivery_enabled or settings.oanda_token or settings.yahoo_enabled):
        raise RuntimeError('Requires the named isolated #74 fixture and disabled external suppliers')
    identity = DatasetIdentity(source='dukascopy', channel='python', environment='historical',
        account_scope='public', provider_symbol='EUR/USD', basis='bid',
        calendar_version='indicator-parity-long-synthetic-ny17-v1')
    start = int(datetime(2026, 9, 21, tzinfo=timezone.utc).timestamp() * 1000)
    end = start + 14 * 86400000
    with transaction() as db:
        original = db.get(Preference, 'acceptance.indicator-parity.20261017')
        if not original or not original.value.get('synthetic'):
            raise RuntimeError('The original isolated seed must exist')
        previous = db.get(Preference, MARKER)
        if previous:
            print(json.dumps(previous.value))
            return
        existing = db.scalar(select(HistoryVersion).where(HistoryVersion.dataset_id == identity.key))
        if existing:
            raise RuntimeError('Incomplete long fixture exists; inspect it instead of creating another version')
        register_dataset(db, identity, logical_symbol='EURUSD', label='长起点 · 独立合成验收',
            calendar='ny17', precision=5, volume_kind='quantity', volume_unit='source_quantity')
        version = create_version(db, identity.key, start, end)

    class Adapter:
        def page(self, identity, start, end):
            rows = []
            for at in range(start, end, 60000):
                index = at // 60000
                price = Decimal(str(round(1.1 + math.sin(index / 13) / 100 + (index % 1440) / 100000, 5)))
                rows.append(MinuteRow(timestamp=at, open=str(price), high=str(price + Decimal('.0002')),
                    low=str(price - Decimal('.0002')), close=str(price + Decimal('.0001')),
                    volume='10', complete=True))
            return CandleBatch(identity=identity, window_start=start, window_end=end, observed_at=end + 60000,
                result=RequestResult(status='data'), rows=tuple(rows), checkpoint=end,
                volume_kind='quantity', volume_unit='source_quantity')

    for _ in range(100):
        import_page(Adapter(), version_id=version)
        with transaction() as db:
            current = db.get(HistoryVersion, version)
            if current.error:
                raise RuntimeError(current.error)
            if current.status == 'published':
                request_artifacts(db, current, ['M1', 'H1'])
                break
    else:
        raise RuntimeError('Long synthetic import failed to publish')
    while artifact_tick(version):
        pass
    with transaction() as db:
        count = db.scalar(select(HistoryArtifact.count).where(HistoryArtifact.version_id == version,
            HistoryArtifact.timeframe == 'M1', HistoryArtifact.status == 'published'))
        if not count or not 6000 < count <= 50000:
            raise RuntimeError('Long fixture is outside the approved scenario boundary')
        result = dict(synthetic=True, version=version, symbol='MWH:' + version.upper(),
            start=start, end=end, input_rows=count, raw_minutes=(end-start)//60000,
            original_seed_preserved=True)
        db.add(Preference(key=MARKER, value=result))
    print(json.dumps(result))


if __name__ == '__main__':
    seed()
