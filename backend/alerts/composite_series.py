"""Bounded fixed-input M1 stitching followed by configured-phase aggregation.

This module is the shared input primitive for charts and strategies. It does not
create demand, download data, activate a revision or claim strategy readiness.
"""

from decimal import Decimal

from .calendar_profile import closures_from
from .chart_data import FRAMES, bounds
from .composite_inputs import rows as tail_rows
from .domain import bucket_bounds, calendar_from, scheduled_open
from .history_versions import snapshot_rows
from .source_registry import collection_identity
from .storage import (
    CompositePreparation,
    CompositeRevision,
    HistoryVersion,
    Instrument,
    MarketComposite,
    MarketDataset,
    RealtimeMapping,
    instant,
    ms,
    now_ms,
)


def period(at, frame, phase):
    if frame not in FRAMES:
        raise ValueError("Unknown composite timeframe")
    if frame == "M1":
        return at // 60000 * 60000, (at // 60000 + 1) * 60000
    function = bounds if frame in ("M30", "W1", "MN") else bucket_bounds
    left, right = function(instant(at), frame, calendar_from(phase, explicit=True))
    return ms(left), ms(right)


def _closed(at, segment, phase):
    return not scheduled_open(instant(at), calendar_from(phase, segment["profile"], explicit=True),
                              closures=closures_from(segment["profile"]))


def aggregate(minutes, frame, *, phase, seam, segments, revision_id, input_revision, now, history_start):
    """Retain original prices and observed segment volumes; never fill a gap."""
    groups = {}
    previous = -1
    for row in minutes:
        at = row["timestamp"]
        if at <= previous or at % 60000:
            raise ValueError("Stitched minutes must be strictly increasing UTC M1")
        previous = at
        expected_segment = "history" if at < seam else "target"
        if row["segment"] != expected_segment or row["source_id"] != segments[expected_segment]["source_id"]:
            raise ValueError("Stitched minute source ownership mismatch")
        groups.setdefault(period(at, frame, phase), []).append(row)
    output = []
    for (left, right), members in sorted(groups.items()):
        observed = {row["timestamp"]: row for row in members}
        unknown, closed, conflicts, display_missing = 0, 0, 0, 0
        for at in range(left, right, 60000):
            segment = segments["history" if at < seam else "target"]
            is_closed = _closed(at, segment, phase)
            if at in observed:
                conflicts += int(is_closed)
                unknown += int(not observed[at]["complete"])
            elif is_closed:
                closed += 1
            else:
                unknown += 1
                display_missing += int(at <= members[-1]['timestamp'])
        coverage = unknown == 0 and left >= history_start
        confirmed = all(row["complete"] for row in members)
        time_closed = right <= now
        sources = {row["source_id"] for row in members}
        units = {(row["volume_kind"], row["volume_unit"]) for row in members}
        compatible = len(sources) == 1 and len(units) == 1
        volumes = all(row.get("volume") is not None for row in members)
        provenance = []
        for name in ("history", "target"):
            start, end = (left, min(right, seam)) if name == "history" else (max(left, seam), right)
            if start >= end:
                continue
            selected = [row for row in members if row["segment"] == name]
            meta = segments[name]
            present = bool(selected) and all(row.get("volume") is not None for row in selected)
            provenance.append({"segment": name, "source_id": meta["source_id"], "start": start, "end": end,
                "observed_minutes": len(selected), "volume_kind": meta["volume_kind"], "volume_unit": meta["volume_unit"],
                "observed_volume": str(sum((Decimal(row["volume"]) for row in selected), Decimal(0))) if present else None,
                "input": meta["input"],
                "provisional_minutes": [row["provisional_input"] for row in selected if "provisional_input" in row]})
        complete = time_closed and confirmed and coverage
        output.append({"start": left, "end": right, "open": members[0]["open"],
            "high": str(max(Decimal(row["high"]) for row in members)),
            "low": str(min(Decimal(row["low"]) for row in members)), "close": members[-1]["close"],
            "volume": str(sum((Decimal(row["volume"]) for row in members), Decimal(0))) if compatible and volumes and coverage else None,
            "volume_kind": next(iter(units))[0] if compatible else "unavailable",
            "volume_unit": next(iter(units))[1] if compatible else None,
            "volume_complete": complete and compatible and volumes,
            "complete": complete, "time_closed": time_closed, "source_confirmed": confirmed,
            "coverage_complete": coverage, "observed_minutes": len(members), "unknown_minutes": unknown,
            "display_coverage_complete": display_missing == 0 and left >= history_start,
            "confirmed_closed_minutes": closed, "session_conflict": bool(conflicts), "conflict_minutes": conflicts,
            "seam_crossing": left < seam < right, "seam_at_start": left == seam,
            "mixed_source": len(sources) > 1, "composite_revision_id": revision_id,
            "input_revision": input_revision, "segments": provenance})
    return output


def read_window(db, composite_id, frame, start, end, *, revision_id=None, input_revision=None,
                provisional=False, now=None, permission_scope="workspace:default", realtime=None, display_snapshot=None):
    """Read a bounded minute partition; outer pagination/materialization owns long history."""
    stamp = now_ms() if now is None else now
    composite = db.get(MarketComposite, composite_id)
    if not composite or composite.permission_scope != permission_scope:
        raise ValueError("Composite unavailable in this permission scope")
    revision = db.get(CompositeRevision, revision_id or composite.active_revision_id)
    if not revision or revision.composite_id != composite.id:
        raise ValueError("Composite revision does not belong to this definition")
    # A week/month containing the Unix epoch may have a negative bucket start;
    # actual source timestamps remain nonnegative and history reads clamp below.
    if not start < end or start % 60000 or end % 60000 or end - start > 32 * 86400000:
        raise ValueError("Use a bounded UTC minute partition of at most 32 days")
    if provisional and input_revision is not None:
        raise ValueError("Fixed confirmed input cannot include mutable stream observations")
    version = db.get(HistoryVersion, revision.history_version_id)
    mapping = db.get(RealtimeMapping, revision.mapping_id)
    target = db.get(MarketDataset, mapping.target_dataset_id)
    target_inst = db.get(Instrument, target.instrument_id)
    prep = db.get(CompositePreparation, revision.id)
    value = display_snapshot.input_revision if display_snapshot else prep.input_revision if input_revision is None else input_revision
    if not 0 <= value <= prep.input_revision:
        raise ValueError("Invalid fixed composite input revision")
    phase = revision.rules["aggregation_calendar"]
    left, right = period(start, frame, phase)[0], period(end - 1, frame, phase)[1]
    if realtime and period(left, frame, phase)[1] != right:
        # This optimization applies only to one bucket; ordinary bounded
        # multi-bucket partitions remain on the authoritative reader.
        realtime = None
    history_meta = {"source_id": collection_identity(version.manifest["identity"]).key,
        "profile": version.manifest.get("calendar_profile", {}),
        "volume_kind": version.manifest["volume_kind"], "volume_unit": version.manifest["volume_unit"],
        "input": {"history_version_id": version.id, "checksum": version.manifest["checksum"]}}
    target_meta = {"source_id": collection_identity(target.identity).key, "profile": target_inst.calendar_profile,
        "volume_kind": target.volume_kind, "volume_unit": target.volume_unit,
        "input": {"composite_revision_id": revision.id, "input_revision": value}}
    segments = {"history": history_meta, "target": target_meta}
    # Only the shared worker supplies this cache. Public historical reads keep
    # their fixed-input behavior and never depend on mutable worker state.
    state = realtime.state(db, revision, frame, left, right, value, version, segments,
                           now=stamp) if realtime else None
    minutes = []
    history_left, history_right = max(left, version.start), min(right, revision.seam, version.end)
    if state is None and history_left < history_right:
        minutes.extend({**row, "segment": "history", "source_id": history_meta["source_id"],
            "volume_kind": history_meta["volume_kind"], "volume_unit": history_meta["volume_unit"]}
            for row in snapshot_rows(db, version.id, start=history_left, end=history_right))
    from .live_window import lower_bound

    tail_left = max(left, revision.seam, lower_bound(stamp))
    if state is None and tail_left < right:
        minutes.extend({**row, "segment": "target"} for row in tail_rows(db, revision.id, tail_left, right,
                                                                         input_revision=value, now=stamp))
    if realtime and state is None:
        state = realtime.initialize(revision, frame, left, version, segments, value, minutes)
    if state:
        # Replace the mutable overlay from durable observations. Removing it
        # here is cache housekeeping, never a freshness-based display eviction.
        for at in list(state.stats["target"]["provisional"]):
            state.remove(at)
    if provisional:
        from .display_observations import read

        if display_snapshot:
            from .display_snapshots import observations

            observed = observations(display_snapshot, tail_left, right)
        else:
            observed = read(db, target.id, revision.id, value, tail_left, right, now=stamp)
        for observation in observed:
            at = observation['start']
            if not (at in state.rows if state else
                    any(row['timestamp'] == at for row in minutes)):
                minutes.append({**observation, 'timestamp': at, 'segment': 'target',
                    'source_id': target_meta['source_id'], 'volume_kind': 'unavailable', 'volume_unit': None})
        minutes.sort(key=lambda row: row['timestamp'])
    if state:
        for row in minutes:
            state.replace(row)
        result = state.result(input_revision=value, now=stamp, segments=segments)
        bars = [result] if result else []
    else:
        bars = aggregate(minutes, frame, phase=phase, seam=revision.seam,
            segments=segments, revision_id=revision.id,
            input_revision=value, now=stamp, history_start=version.start)
    return {"composite_id": composite.id, "revision_id": revision.id, "input_revision": value,
        "history_version_id": version.id, "seam": revision.seam, "timeframe": frame,
        "bars": [row for row in bars if start <= row["start"] < end],
        "rule_version": revision.rules["aggregation"], "preparation_status": prep.status,
        "queried_cutoff": prep.cutoff, "current_observed_confirmed_end": prep.confirmed_end}
