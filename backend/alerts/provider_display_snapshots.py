"""Short-lived provider price credentials, shared across API and worker processes.

Only the mutable final observation is copied. Earlier corrections rotate the
history epoch and invalidate the credential rather than mix two observations.
The existing preference store keeps this accelerator compatible with old images.
"""

import hashlib
import json
import logging
import uuid

from sqlalchemy import delete, select, text

from .display_snapshots import DisplaySnapshotError
from .source_history_store import _insert
from .storage import Preference, ProviderBar, ProviderDataset, now_ms

PREFIX = 'provider-display:'
LEASE_MS = 120000
MAX_SNAPSHOTS = 2048
log = logging.getLogger(__name__)


def _calendar(meta):
    return {k: meta.get(k) for k in ('calendar', 'calendar_profile')}


def capture(db, page, *, full_series=True):
    from .provider_cache import SOURCE_BEFORE
    if not page['bars']:
        return
    dataset = db.get(ProviderDataset, page['dataset_id'])
    if dataset is None:
        return
    tail = page['bars'][-1]
    last = dataset.metadata_json.get('indicator_tail_start')
    if full_series and (last is None or last > tail['start']):
        tail = db.scalar(select(ProviderBar.payload).where(ProviderBar.dataset_id == dataset.id,
                         ProviderBar.start < (SOURCE_BEFORE.get() or now_ms() + 1))
                         .order_by(ProviderBar.start.desc()).limit(1)) or tail
    content = {'dataset': dataset.id, 'revision': dataset.revision,
               'epoch': dataset.metadata_json.get('indicator_history_epoch'),
               'calendar': _calendar(dataset.metadata_json), 'tail': tail,
               'as_of': page['as_of']}
    raw = json.dumps(content, sort_keys=True, separators=(',', ':')).encode()
    page['_provider_snapshot'] = content
    page['provider_snapshot_id'] = hashlib.sha256(raw).hexdigest()


def publish(page):
    """Persist frozen plain values only after the read connection is released."""
    from .provider_cache import budget_transaction

    content = page.pop('_provider_snapshot', None)
    if content is None:
        return
    stamp = now_ms()
    key = PREFIX + page['provider_snapshot_id']
    with budget_transaction() as db:
        # A short global lock bounds this small store under concurrent readers.
        # It never locks the source dataset or participates in its RR snapshot.
        if db.bind.dialect.name == 'postgresql':
            db.execute(text('SELECT pg_advisory_xact_lock(8675311)'))
        old = db.get(Preference, key)
        if old and old.value['expires'] > stamp + LEASE_MS // 2:
            return
        retained = list(db.scalars(select(Preference).where(Preference.key.startswith(PREFIX))))
        expired = [r.key for r in retained if r.value['expires'] <= stamp]
        live = sorted((r for r in retained if r.key not in expired and r.key != key),
                      key=lambda r: r.value['expires'])
        expired.extend(r.key for r in live[:max(0, len(live) + 1 - MAX_SNAPSHOTS)])
        if expired:
            db.execute(delete(Preference).where(Preference.key.in_(expired)))
        value = {'expires': stamp + LEASE_MS, 'content': content}
        stmt = _insert(db)(Preference).values(key=key, value=value)
        db.execute(stmt.on_conflict_do_update(index_elements=['key'], set_={'value': value}))


def resolve(db, ident, dataset_id):
    record = db.get(Preference, PREFIX + ident)
    dataset = db.get(ProviderDataset, dataset_id)
    content = record.value['content'] if record else None
    epoch = dataset.metadata_json.get('indicator_history_epoch') if dataset else None
    reason = None
    if not content or not dataset:
        reason = 'missing'
    elif record.value['expires'] <= now_ms():
        reason = 'ttl'
    elif content['dataset'] != dataset_id:
        reason = 'identity'
    elif content['epoch'] != epoch:
        reason = 'epoch'
    elif content['calendar'] != _calendar(dataset.metadata_json):
        reason = 'calendar'
    elif epoch is None and content['revision'] != dataset.revision:
        reason = 'legacy'
    if reason:
        # Per-attempt correlation plus a one-way credential reference; never log
        # tokens, supplier/account identities, candle values or calendar payloads.
        log.info('provider-display-snapshot-rejected %s', json.dumps({
            'attempt_ref': uuid.uuid4().hex,
            'credential_ref': hashlib.sha256(ident.encode()).hexdigest()[:16],
            'reason': reason,
            'snapshot_revision': content.get('revision') if content else None,
            'current_revision': dataset.revision if dataset else None,
        }, sort_keys=True))
        raise DisplaySnapshotError('DISPLAY_SNAPSHOT_EXPIRED',
                                   '平台展示快照已过期或历史已修订，请重新读取价格快照')
    return content


def read(db, content, before, count, ident):
    """Read immutable history and overlay the accepted final observation."""
    tail = content['tail']
    ceiling = min(before, tail.get('chart_time', tail['start']) + 1)
    rows = list(db.scalars(select(ProviderBar.payload).where(
        ProviderBar.dataset_id == content['dataset'], ProviderBar.chart_time < ceiling,
        ProviderBar.start < tail['start']).order_by(ProviderBar.chart_time.desc()).limit(count + 1)))[::-1]
    if tail.get('chart_time', tail['start']) < ceiling:
        rows.append(tail)
    dataset = db.get(ProviderDataset, content['dataset'])
    boundary = dataset.earliest and len(rows) <= count
    return {'dataset_id': dataset.id, 'bars': rows[-count:], 'has_more': not boundary,
            'history_boundary': bool(boundary), 'as_of': content['as_of'],
            'cache_revision': content['revision'], 'provider_snapshot_id': ident,
            'cache_hit': True}
