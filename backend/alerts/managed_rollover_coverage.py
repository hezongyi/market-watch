"""Prove a managed candidate retains the old revision's observed M1 data.

Unchanged immutable history partitions need no payload scan. Changed partitions
and the finite live tail compare actual timestamps, never an ideal minute grid.
"""

from sqlalchemy import select

from .history_versions import snapshot_rows
from .storage import CompositeMinuteInput, HistoryArtifact, HistoryChunk, HistoryVersion


def fingerprint(previous, target, old_prep, prep):
    return [previous.id, old_prep.input_revision, target.id, prep.input_revision]


def _missing(before, after, segment, *, latest=False):
    lost = before - after
    # Small source corrections/gaps are normal. Losing the newest served bar or
    # more than 1% (at least four observations) is a material regression.
    if before and (latest and max(before) not in after or len(lost) > max(3, len(before) // 100)):
        raise ValueError(f"{segment}缺少旧基线已有的 {len(lost)} 根 M1，保留当前基线")
    return len(lost)


def _history(db, version_id, start, end):
    if start >= end:
        return set()
    return {row["timestamp"] for row in snapshot_rows(db, version_id, start=start, end=end)}


def history_coverage(db, previous, new):
    """Immutable coverage qualification belongs in newest-valid selection."""
    old = db.get(HistoryVersion, previous.history_version_id)
    artifacts = {row.version_id: row for row in db.scalars(select(HistoryArtifact).where(
        HistoryArtifact.version_id.in_({old.id, new.id}), HistoryArtifact.timeframe == "M1"))}
    if artifacts[new.id].count + max(3, artifacts[old.id].count // 100) < artifacts[old.id].count:
        raise ValueError("新固定 M1 产物显著减少，保留当前基线")
    unchanged = {(row.start, row.end, row.checksum) for row in db.scalars(select(HistoryChunk).where(
        HistoryChunk.version_id == new.id, HistoryChunk.timeframe == "M1"))}
    checked, missing = 0, 0
    for chunk in db.scalars(select(HistoryChunk).where(
            HistoryChunk.version_id == old.id, HistoryChunk.timeframe == "M1",
            HistoryChunk.start < previous.seam).order_by(HistoryChunk.start)):
        if (chunk.start, chunk.end, chunk.checksum) in unchanged:
            continue
        start, end = max(old.start, chunk.start), min(chunk.end, previous.seam, old.end)
        before = _history(db, old.id, start, end)
        missing += _missing(before, _history(db, new.id, start, end), "固定历史")
        checked += len(before)
    return checked, missing


def prove(db, previous, target, old_prep, prep):
    """Caller holds both dataset fences; proof is valid for these exact inputs."""
    token = fingerprint(previous, target, old_prep, prep)
    if prep.state.get("managed_coverage", {}).get("fingerprint") == token:
        return
    new = db.get(HistoryVersion, target.history_version_id)
    checked, missing = history_coverage(db, previous, new)
    # This also covers the section that moves from the live supplier into the
    # new fixed baseline, omitted by the ordinary shared-history shadow sample.
    before = set(db.scalars(select(CompositeMinuteInput.start).where(
        CompositeMinuteInput.revision_id == previous.id,
        CompositeMinuteInput.input_revision <= old_prep.input_revision,
        CompositeMinuteInput.start < old_prep.confirmed_end)))
    after = _history(db, new.id, previous.seam, min(target.seam, old_prep.confirmed_end))
    after.update(db.scalars(select(CompositeMinuteInput.start).where(
        CompositeMinuteInput.revision_id == target.id,
        CompositeMinuteInput.input_revision <= prep.input_revision,
        CompositeMinuteInput.start < old_prep.confirmed_end)))
    missing += _missing(before, after, "确认尾部", latest=True)
    prep.state = {**prep.state, "managed_coverage": {
        "fingerprint": token, "changed_history_observations": checked,
        "tail_observations": len(before), "missing_observations": missing}}
