"""Compare accepted price projections, separately from fixed-input audit hashes."""

from decimal import Decimal

from sqlalchemy import select

from .composite_series import period, read_window
from .display_snapshots import resolve
from .storage import CompositeMinuteInput, CompositeRevision


def projection(bar):
    if bar is None:
        return None
    return (bar['start'], *(Decimal(bar[key]) for key in ('open', 'high', 'low', 'close')),
            Decimal(bar['volume']) if bar.get('volume') is not None else None)


def changed_buckets(db, composite_id, revision_id, frame, old_id, new_id, start, end, stamp):
    revision = db.get(CompositeRevision, revision_id)
    try:
        old = resolve(db, old_id, revision, frame, stamp)
        new = resolve(db, new_id, revision, frame, stamp)
    except ValueError:
        return None
    if new.input_revision < old.input_revision:
        return None
    old_rows = {row['start']: row for row in old.content['observations']}
    new_rows = {row['start']: row for row in new.content['observations']}
    candidates = {at for at in old_rows.keys() | new_rows.keys() if old_rows.get(at) != new_rows.get(at)}
    candidates.update(db.scalars(select(CompositeMinuteInput.start).where(
        CompositeMinuteInput.revision_id == revision_id,
        CompositeMinuteInput.input_revision > old.input_revision,
        CompositeMinuteInput.input_revision <= new.input_revision,
        CompositeMinuteInput.start >= start, CompositeMinuteInput.start < end)))
    phase = revision.rules['aggregation_calendar']
    windows = {period(at, frame, phase) for at in candidates if start <= at < end}
    if len(windows) > 256:
        return None
    changed = []
    for left, right in sorted(windows):
        pages = [read_window(db, composite_id, frame, left, right, revision_id=revision_id,
            provisional=True, now=snapshot.content['now'], display_snapshot=snapshot)['bars']
            for snapshot in (old, new)]
        if projection(pages[0][0] if pages[0] else None) != projection(pages[1][0] if pages[1] else None):
            changed.append(left)
    return changed
