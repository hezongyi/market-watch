"""Exact display credentials shared by price pages, stream and Python studies.

The payload copies accepted observations; confirmation GC cannot change a token.
Fixed input_revision remains a separate, immutable confirmation credential.
"""

import hashlib
import json

from sqlalchemy import delete, func, select, text, update

from .display_observations import read
from .source_history_store import _insert
from .storage import (
    CompositePreparation,
    DisplaySnapshot,
    HistoryVersion,
    LiveState,
    MarketDataset,
    Preference,
    RealtimeMapping,
)

LEASE_MS = 120000
MAX_SNAPSHOTS = 512
MAX_BYTES = 64 * 1024 * 1024


class DisplaySnapshotError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def renew(db, snapshot, stamp):
    deadline = stamp + LEASE_MS
    db.execute(update(DisplaySnapshot).where(DisplaySnapshot.id == snapshot.id,
        DisplaySnapshot.expires_at < deadline).values(expires_at=deadline)
        .execution_options(synchronize_session=False))


def lock_inputs(db, revision):
    """Pin history and live payloads in the judgment's dataset order."""
    history = db.get(HistoryVersion, revision.history_version_id)
    mapping = db.get(RealtimeMapping, revision.mapping_id)
    list(db.scalars(select(MarketDataset.id).where(MarketDataset.id.in_(
        {history.dataset_id, mapping.target_dataset_id})).order_by(MarketDataset.id)
        .with_for_update(read=True)))


def capture(db, revision, frame, stamp):
    from .composite_series import period

    # Confirmation writes use this same lock. An old fixed version must not be
    # paired with observations already reclaimed by a newer confirmation.
    # Pin the historical prefix before adopting mutable legacy observations;
    # taking only the live parent here can deadlock with a sorted judgment.
    lock_inputs(db, revision)
    mapping = db.get(RealtimeMapping, revision.mapping_id)
    state = db.get(LiveState, mapping.target_dataset_id)
    if state:
        from .display_observations import handover_legacy

        handover_legacy(db, state)
    # Lock LiveState before preparation, matching confirmation's flush order.
    # A quote publisher updates this row before changing its observation. This
    # prevents a mid-read quote from erasing the prior visible mutable row.
    db.scalar(select(LiveState).where(LiveState.dataset_id == mapping.target_dataset_id)
              .with_for_update(read=True))
    prep = db.scalar(select(CompositePreparation).where(
        CompositePreparation.revision_id == revision.id).with_for_update(read=True)
        .execution_options(populate_existing=True))
    observations = read(db, mapping.target_dataset_id, revision.id, prep.input_revision,
                        revision.seam, stamp + 1, now=stamp)
    degraded = db.get(Preference, 'display_capacity:' + mapping.target_dataset_id)
    content = {'observations': observations, 'degraded': degraded.value if degraded else None,
               'now': period(stamp, 'M1', revision.rules['aggregation_calendar'])[0],
               'rules': revision.rules}
    raw = json.dumps([revision.id, frame, prep.input_revision, content],
        sort_keys=True, separators=(',', ':')).encode()
    ident = hashlib.sha256(raw).hexdigest()
    snapshot = db.get(DisplaySnapshot, ident)
    if snapshot:
        renew(db, snapshot, stamp)
        return snapshot
    if db.bind.dialect.name == 'postgresql':
        db.execute(text('SELECT pg_advisory_xact_lock(8675310)'))
        # Another reader can have inserted this identical credential while we
        # waited. Reuse it before applying capacity, especially at the limit.
        snapshot = db.get(DisplaySnapshot, ident)
        if snapshot:
            renew(db, snapshot, stamp)
            return snapshot
    db.execute(delete(DisplaySnapshot).where(DisplaySnapshot.expires_at < stamp))
    size = db.scalar(select(func.count()).select_from(DisplaySnapshot).where(
        DisplaySnapshot.revision_id == revision.id, DisplaySnapshot.timeframe == frame))
    weight = db.scalar(select(func.sum(DisplaySnapshot.size_bytes))) or 0
    if size >= MAX_SNAPSHOTS or weight + len(raw) > MAX_BYTES:
        raise DisplaySnapshotError('DISPLAY_SNAPSHOT_CAPACITY',
            '展示快照容量已满，等待现有快照释放后恢复')
    db.execute(_insert(db)(DisplaySnapshot).values(id=ident, revision_id=revision.id,
        timeframe=frame, input_revision=prep.input_revision, content=content,
        expires_at=stamp + LEASE_MS, size_bytes=len(raw)).on_conflict_do_nothing(index_elements=['id']))
    return db.get(DisplaySnapshot, ident)


def resolve(db, ident, revision, frame, stamp):
    snapshot = db.get(DisplaySnapshot, ident)
    if (not snapshot or snapshot.revision_id != revision.id or snapshot.timeframe != frame
            or snapshot.expires_at < stamp or snapshot.content['rules'] != revision.rules):
        raise DisplaySnapshotError('DISPLAY_SNAPSHOT_EXPIRED',
            '展示快照已过期或身份不匹配，请读取新的价格快照')
    renew(db, snapshot, stamp)
    return snapshot


def observations(snapshot, start, end):
    return [row for row in snapshot.content['observations'] if start <= row['start'] < end]
