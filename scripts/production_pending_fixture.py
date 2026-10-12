"""Synthetic recheck setup only in this task's isolated Ubuntu database."""
import os
from sqlalchemy import select
from sqlalchemy.engine import make_url
from alerts.config import settings
from alerts.storage import CompositeRevision, CompositePreparation, transaction, now_ms
from alerts import composite_preparation as preparation
from alerts.market_contracts import CandleBatch, RequestResult

url = make_url(settings.database_url)
if (os.environ.get('MW_PENDING_ACCEPTANCE_TASK') != 'mw-pending-fixes-20261013'
        or url.host != 'pg' or url.database != 'production_ux_acceptance'
        or settings.delivery_enabled or settings.oanda_token or settings.yahoo_enabled):
    raise RuntimeError('Requires task-local synthetic acceptance configuration')

with transaction() as db:
    revisions = list(db.scalars(select(CompositeRevision.id)))
    for revision_id in revisions:
        prep = db.get(CompositePreparation, revision_id)
        if prep.lease_until > now_ms():
            raise RuntimeError('Stop this task history worker and wait for its source lease before seeding')
        prep.next_at = 0
        if prep.status == 'configuration_error':
            prep.status = 'pending'
for revision_id in revisions:
    while owned := preparation.claim(revision_id):
        # Explicit synthetic no-observation response. Query completion leaves
        # every missing minute unknown; it cannot certify coverage or readiness.
        preparation.commit(owned, CandleBatch(identity=owned['identity'], window_start=owned['start'],
            window_end=owned['end'], checkpoint=owned['end'], observed_at=now_ms(), rows=(),
            result=RequestResult(status='empty_success'), volume_kind='price_count', volume_unit='quotes'))
with transaction() as db:
    if any(db.get(CompositePreparation, revision_id).status != 'queried' for revision_id in revisions):
        raise RuntimeError('Synthetic preparation did not complete its bounded queries')
print('Synthetic recheck fixture queried; prices unchanged and missing minutes unknown')
