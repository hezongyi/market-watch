"""Task-only synthetic import through the actual PG maintenance/derive paths."""
import json
import sys
import uuid
from sqlalchemy.engine import make_url
from alerts.config import settings
from alerts.storage import HistoryVersion, transaction, now_ms
from alerts.market_contracts import DatasetIdentity, MinuteRow, CandleBatch, RequestResult
from alerts.market_datasets import register_dataset
from alerts.history_maintenance import configure, create_run
from alerts.history_versions import import_page, version_report
from alerts.history_artifacts import artifact_tick

url = make_url(settings.database_url)
assert url.host == 'pg' and url.database == 'pro_charts'
assert settings.database_application_name == 'mw-pro-charts-20261011' and not settings.delivery_enabled
mode = sys.argv[1]
if mode == 'seed':
    identity = DatasetIdentity(source='dukascopy', channel='python', environment='historical',
        account_scope='public', provider_symbol='AUD/USD', basis='bid',
        calendar_version='progress-acceptance-v2-' + uuid.uuid4().hex)
    end = (now_ms()-5000)//60000*60000
    start = end - 12001*60000
    with transaction() as db:
        register_dataset(db, identity, logical_symbol='AUDUSD', label='派生进度验收', calendar='ny17',
            precision=5, volume_kind='quantity', volume_unit='source_quantity')
        configure(db, identity.key, target_start=start, timeframes=['M1','H1'], frequency='once')
        ident = create_run(db, identity.key, end=end, request_id=str(uuid.uuid4())).id
    class Adapter:
        def page(self, identity, left, right):
            return CandleBatch(identity=identity, window_start=left, window_end=right, observed_at=now_ms(),
                result=RequestResult(status='data'), checkpoint=right, volume_kind='quantity', volume_unit='source_quantity',
                rows=tuple(MinuteRow(timestamp=at, open='0.65000', high='0.65002', low='0.64998',
                    close='0.65001', volume='1', complete=True) for at in range(left, right, 60000)))
    while import_page(Adapter(), version_id=ident):
        with transaction() as db:
            if db.get(HistoryVersion, ident).status == 'published':
                break
    assert artifact_tick(ident)
elif mode in ('advance','finish'):
    ident = str(uuid.UUID(sys.argv[2]))
    with transaction() as db:
        version = db.get(HistoryVersion, ident)
        assert version and version.manifest['identity']['calendar_version'].startswith('progress-acceptance-v2-')
    if mode == 'advance':
        assert artifact_tick(ident)
    else:
        while artifact_tick(ident):
            pass
else:
    raise ValueError('Unknown progress fixture mode')
with transaction() as db:
    report = version_report(db, ident)
    print(json.dumps({'version': ident, 'dataset': report['dataset_id'], 'progress': report['derivation']}))
