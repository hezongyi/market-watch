"""Indexed composite chart pagination over fixed input revisions.

Reuse published buckets wholly before the seam bucket. Only the seam bucket and
bounded target windows are read as stitched M1; never scan ten-year M1 on a page.
"""

import hashlib
import json

from sqlalchemy import func, select

from .composite_series import period, read_window
from .history_artifacts import read_artifact
from .source_registry import collection_identity
from .storage import (
    CompositeMinuteInput,
    CompositePreparation,
    CompositeRevision,
    HistoryVersion,
    MarketComposite,
    now_ms,
)

SPAN = {"M1": 60000, "M5": 300000, "M15": 900000, "M30": 1800000,
        "H1": 3600000, "H4": 14400000, "D1": 86400000, "W1": 7 * 86400000, "MN": 31 * 86400000}


def chart_page(db, composite_id, frame, *, before=None, count=300, revision_id=None,
               input_revision=None, provisional=False, now=None, permission_scope="workspace:default", realtime=None, display_snapshot=None):
    stamp = now_ms() if now is None else now
    if frame not in SPAN or not 1 <= count <= 2000 or before is not None and before < 0:
        raise ValueError("无效组合图表分页")
    composite = db.get(MarketComposite, composite_id)
    if not composite or composite.permission_scope != permission_scope:
        raise ValueError("组合行情不存在或不属于当前权限范围")
    revision = db.get(CompositeRevision, revision_id or composite.active_revision_id)
    if not revision or revision.composite_id != composite.id:
        raise ValueError("组合修订不属于当前组合")
    if provisional:
        from .display_snapshots import capture

        display_snapshot = display_snapshot or capture(db, revision, frame, stamp)
        stamp = display_snapshot.content['now']
    prep = db.get(CompositePreparation, revision.id)
    value = display_snapshot.input_revision if display_snapshot else prep.input_revision if input_revision is None else input_revision
    if not 0 <= value <= prep.input_revision:
        raise ValueError("无效的组合输入修订")
    if provisional and input_revision is not None:
        raise ValueError("固定确认输入版本不能包含实时临时观察")
    version = db.get(HistoryVersion, revision.history_version_id)
    if realtime and before is None and provisional:
        from types import SimpleNamespace

        selected = SimpleNamespace(input_revision=value, status=prep.status, cutoff=prep.cutoff, confirmed_end=prep.confirmed_end)
        return realtime.page(db, composite, revision, selected, version, frame, count, stamp,
                             permission_scope, display_snapshot=display_snapshot)
    phase, seam = revision.rules["aggregation_calendar"], revision.seam
    seam_bucket = period(seam, frame, phase)[0]
    cutoff = stamp + 1 if before is None else before
    output, partitions = [], 0
    cursor = cutoff
    from .composite_aggregates import read

    persisted = read(db, revision.id, frame, value, before=cutoff, count=count + 1, now=stamp)
    if persisted is not None:
        output, cursor = persisted, seam_bucket
    # Jump across missing intervals by indexed observed timestamps. Fixed input
    # versions filter revisions before selecting, so current heads cannot leak in.
    def latest_minute(bound):
        from .live_window import lower_bound

        query = select(func.max(CompositeMinuteInput.start)).where(
            CompositeMinuteInput.revision_id == revision.id,
            CompositeMinuteInput.input_revision <= value,
            CompositeMinuteInput.start < bound, CompositeMinuteInput.start >= max(seam, lower_bound(stamp)))
        return db.scalar(query)

    def latest_display(bound):
        confirmed = latest_minute(bound)
        observed = max((row['start'] for row in display_snapshot.content['observations']
                        if seam <= row['start'] < bound), default=None) if display_snapshot else None
        candidates = [at for at in (confirmed, observed) if at is not None]
        return max(candidates) if candidates else None

    latest = latest_display(period(cursor - 1, frame, phase)[1]) if cursor > seam_bucket else None
    if provisional and persisted is not None and cutoff > seam_bucket:
        # Materialized confirmed buckets do not contain older pending minutes.
        # Overlay every affected bucket, including pending below the fixed tail.
        candidates = display_snapshot.content['observations']
        affected = sorted({period(row['start'], frame, phase) for row in candidates
                           if period(row['start'], frame, phase)[0] < cutoff})[-(count + 1):]
        for left, right in affected:
            sampled = read_window(db, composite.id, frame, left, right, revision_id=revision.id,
                provisional=True, now=stamp, permission_scope=permission_scope, realtime=realtime, display_snapshot=display_snapshot)['bars']
            output = sorted([bar for bar in output if bar['start'] != left] + sampled,
                            key=lambda bar: bar['start'])
    while cursor > seam_bucket and len(output) <= count and partitions < 4:
        if latest is None:
            # W1/MN can contain historical observations in the seam bucket even
            # before the first target minute arrives.
            if seam_bucket < cutoff:
                right = period(seam, frame, phase)[1]
                page = read_window(db, composite.id, frame, seam_bucket, right, revision_id=revision.id,
                    input_revision=None if provisional else value, provisional=provisional,
                    now=stamp, permission_scope=permission_scope, display_snapshot=display_snapshot)
                output = [row for row in page["bars"] if row["start"] < cutoff] + output
                partitions += 1
            cursor = seam_bucket
            break
        right = period(latest, frame, phase)[1]
        # At most one month of M1 per partition. Whole buckets can expand the
        # window at its edge; MN deliberately reads one bucket per partition.
        span = min(28 * 86400000, SPAN[frame] * (count + 2))
        left = period(max(seam_bucket, right - span), frame, phase)[0]
        if right - left > 32 * 86400000 or frame == "MN":
            left = period(right - 1, frame, phase)[0]
        left = max(left, seam_bucket)
        page = read_window(db, composite.id, frame, left, right, revision_id=revision.id,
            input_revision=None if provisional else value, provisional=provisional,
            now=stamp, permission_scope=permission_scope, display_snapshot=display_snapshot)
        output = [row for row in page["bars"] if row["start"] < cutoff] + output
        partitions += 1
        cursor = left
        latest = latest_display(left) if left > seam_bucket else None
        if left == seam_bucket:
            break
    pending = []
    if display_snapshot and display_snapshot.content.get('degraded'):
        pending.append('待确认观测容量已满，已保留现有图表并暂停追加；确认补齐后恢复')
    if cursor <= seam_bucket and len(output) <= count:
        try:
            history = read_artifact(db, version.id, frame, end=min(cutoff, seam_bucket),
                                    limit=count + 1 - len(output), newest_first=True)
        except ValueError as error:
            if "尚未发布" not in str(error):
                raise
            history = []
            pending.append("历史周期产物尚未发布，已保留组合基线；等待后台派生")
        source_id = collection_identity(version.manifest["identity"]).key
        output = [{**row, "composite_revision_id": revision.id, "input_revision": value,
            "seam_crossing": False, "seam_at_start": row["start"] == seam,
            "mixed_source": False, "segments": [{"segment": "history", "source_id": source_id,
                "start": row["start"], "end": row["end"], "observed_minutes": row["observed_minutes"],
                "volume_kind": row["volume_kind"], "volume_unit": row["volume_unit"],
                "observed_volume": row["volume"], "provisional_minutes": [],
                "input": {"history_version_id": version.id, "checksum": version.manifest["checksum"]}}]}
            for row in history] + output
    bars = output[-count:]
    more = len(output) > count
    next_before = bars[0]["start"] if more else cursor if cursor > seam_bucket else None
    if pending and next_before is None:
        next_before = min(cutoff, seam_bucket) if seam_bucket > version.start else None
    fingerprint = {"revision": revision.id, "input": value, "baseline": version.manifest["checksum"],
        "provisional": [row["segments"] for row in bars if not row["source_confirmed"]]}
    return {"composite_id": composite.id, "revision_id": revision.id, "input_revision": value,
        "history_version_id": version.id, "seam": seam, "timeframe": frame, "bars": bars,
        **({'display_snapshot_id': display_snapshot.id} if display_snapshot else {}),
        "next_before": next_before, "has_more": next_before is not None,
        "history_revision": hashlib.sha256(json.dumps(fingerprint, sort_keys=True).encode()).hexdigest(),
        "origin": version.start, "rule_version": revision.rules["aggregation"],
        "preparation_status": prep.status, "pending": pending, "bounded_partitions": partitions,
        "materialized": persisted is not None,
        "queried_cutoff": prep.cutoff, "current_observed_confirmed_end": prep.confirmed_end}
