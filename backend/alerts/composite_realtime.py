"""Replaceable current-bucket observations with cached calendar evidence.

The worker owns this state; consumers never own aggregation caches. Rebuilding
after takeover is safe because confirmed inputs remain authoritative in PG.
"""

import bisect
import copy
import heapq
from collections import Counter
from decimal import Decimal

from .composite_series import _closed, period


class Bucket:
    def __init__(self, at, frame, *, phase, seam, segments, revision_id, history_start):
        self.left, self.right = period(at, frame, phase)
        self.frame, self.phase, self.seam = frame, phase, seam
        self.segments, self.revision_id, self.history_start = segments, revision_id, history_start
        self.closed = {t for t in range(self.left, self.right, 60000)
                       if _closed(t, segments["history" if t < seam else "target"], phase)}
        self.rows, self.times, self.highs, self.lows = {}, [], [], []
        self.units, self.sources = Counter(), Counter()
        self.incomplete = self.conflicts = 0
        self.stats = {name: {"count": 0, "missing": 0, "volume": Decimal(0), "provisional": {}}
                      for name in segments}
        self.changes = 0

    def _account(self, row, direction):
        at, name = row["timestamp"], row["segment"]
        self.units[(row["volume_kind"], row["volume_unit"])] += direction
        self.sources[row["source_id"]] += direction
        self.incomplete += direction * int(not row["complete"])
        self.conflicts += direction * int(at in self.closed)
        stats = self.stats[name]
        stats["count"] += direction
        stats["missing"] += direction * int(row.get("volume") is None)
        stats["volume"] += direction * Decimal(row["volume"] or "0")
        if "provisional_input" in row:
            if direction > 0:
                stats["provisional"][at] = row["provisional_input"]
            else:
                stats["provisional"].pop(at, None)

    def replace(self, row):
        at = row["timestamp"]
        name = "history" if at < self.seam else "target"
        if (at % 60000 or not self.left <= at < self.right or row["segment"] != name
                or row["source_id"] != self.segments[name]["source_id"]):
            raise ValueError("Realtime minute source ownership/window mismatch")
        self.remove(at)
        self.rows[at] = dict(row)
        bisect.insort(self.times, at)
        self._account(row, 1)
        heapq.heappush(self.highs, (-Decimal(row["high"]), at))
        heapq.heappush(self.lows, (Decimal(row["low"]), at))
        self.changes += 1
        # Lazy extremes are compacted with a fixed bound, never per quote.
        if len(self.highs) + len(self.lows) > 4 * len(self.rows) + 128:
            self.highs = [(-Decimal(r["high"]), t) for t, r in self.rows.items()]
            self.lows = [(Decimal(r["low"]), t) for t, r in self.rows.items()]
            heapq.heapify(self.highs)
            heapq.heapify(self.lows)

    def remove(self, at):
        old = self.rows.pop(at, None)
        if old is not None:
            self.times.pop(bisect.bisect_left(self.times, at))
            self._account(old, -1)

    def _extreme(self, heap, field, sign):
        while heap:
            value, at = heap[0]
            row = self.rows.get(at)
            if row is not None and value == sign * Decimal(row[field]):
                return sign * value
            heapq.heappop(heap)
        raise ValueError("No realtime observations")

    def result(self, *, input_revision, now, segments=None):
        if not self.times:
            return None
        meta = segments or self.segments
        unknown = ((self.right - self.left) // 60000 - len(self.rows)
                   - (len(self.closed) - self.conflicts) + self.incomplete)
        coverage = unknown == 0 and self.left >= self.history_start
        display_missing = ((self.times[-1] + 60000 - self.left) // 60000 - len(self.rows)
            - sum(at <= self.times[-1] for at in self.closed) + self.conflicts)
        confirmed, time_closed = self.incomplete == 0, self.right <= now
        units = [unit for unit, count in self.units.items() if count]
        compatible = len([s for s, count in self.sources.items() if count]) == 1 and len(units) == 1
        volumes = all(not stats["missing"] for stats in self.stats.values())
        complete = confirmed and time_closed and coverage
        provenance = []
        for name in ("history", "target"):
            start, end = ((self.left, min(self.right, self.seam)) if name == "history"
                          else (max(self.left, self.seam), self.right))
            if start >= end:
                continue
            stats, segment = self.stats[name], meta[name]
            provenance.append({"segment": name, "source_id": segment["source_id"],
                "start": start, "end": end, "observed_minutes": stats["count"],
                "volume_kind": segment["volume_kind"], "volume_unit": segment["volume_unit"],
                "observed_volume": str(stats["volume"]) if stats["count"] and not stats["missing"] else None,
                "input": segment["input"],
                "provisional_minutes": [value for _, value in sorted(stats["provisional"].items())]})
        first, last = self.rows[self.times[0]], self.rows[self.times[-1]]
        return {"start": self.left, "end": self.right, "open": first["open"],
            "high": str(self._extreme(self.highs, "high", -1)),
            "low": str(self._extreme(self.lows, "low", 1)), "close": last["close"],
            "volume": str(sum((s["volume"] for s in self.stats.values()), Decimal(0)))
                if compatible and volumes and coverage else None,
            "volume_kind": units[0][0] if compatible else "unavailable",
            "volume_unit": units[0][1] if compatible else None,
            "volume_complete": complete and compatible and volumes, "complete": complete,
            "time_closed": time_closed, "source_confirmed": confirmed, "coverage_complete": coverage,
            "observed_minutes": len(self.rows), "unknown_minutes": unknown,
            "display_coverage_complete": display_missing == 0 and self.left >= self.history_start,
            "confirmed_closed_minutes": len(self.closed) - self.conflicts,
            "session_conflict": bool(self.conflicts), "conflict_minutes": self.conflicts,
            "seam_crossing": self.left < self.seam < self.right, "seam_at_start": self.left == self.seam,
            "mixed_source": len([s for s, count in self.sources.items() if count]) > 1,
            "composite_revision_id": self.revision_id, "input_revision": input_revision,
            "segments": provenance}


class CurrentBuckets:
    """One bucket per revision/period; confirmed deltas update indexed minutes."""

    def __init__(self, limit=256):
        self.items = {}
        self.pages = {}
        self.limit = limit
        self.builds = self.delta_reads = 0

    def state(self, db, revision, frame, left, right, value, version, segments, *, now=None):
        from sqlalchemy import select

        from .composite_inputs import rows
        from .storage import CompositeMinuteInput

        key = (revision.id, frame)
        old = self.items.get(key)
        identity = (left, right, version.manifest["checksum"], revision.rules, segments["target"]["profile"])
        if not old or old[0] != identity or value < old[1]:
            return None
        state, applied = old[2], old[1]
        from .live_window import lower_bound

        lower = lower_bound(now)
        for at in list(state.rows):
            if revision.seam <= at < lower:
                state.remove(at)
        if applied < value:
            changed = list(db.scalars(select(CompositeMinuteInput.start).where(
                CompositeMinuteInput.revision_id == revision.id,
                CompositeMinuteInput.input_revision > applied,
                CompositeMinuteInput.input_revision <= value,
                CompositeMinuteInput.start >= left, CompositeMinuteInput.start < right).distinct()))
            for at in changed:
                confirmed = next(iter(rows(db, revision.id, at, at + 60000,
                                           input_revision=value, now=now)), None)
                if confirmed:
                    state.replace({**confirmed, "segment": "target"})
            self.delta_reads += len(changed)
            self.items[key] = (identity, value, state)
        return state

    def initialize(self, revision, frame, left, version, segments, value, minutes):
        state = Bucket(left, frame, phase=revision.rules["aggregation_calendar"], seam=revision.seam,
                       segments=segments, revision_id=revision.id, history_start=version.start)
        for row in minutes:
            state.replace(row)
        identity = (state.left, state.right, version.manifest["checksum"], revision.rules,
                    segments["target"]["profile"])
        key = (revision.id, frame)
        self.items.pop(key, None)
        self.items[key] = (identity, value, state)
        while len(self.items) > self.limit:
            self.items.pop(next(iter(self.items)))
        self.builds += 1
        return state

    def page(self, db, composite, revision, prep, version, frame, count, stamp, permission_scope, *, display_snapshot=None):
        """Reuse the confirmed tail; quote updates read only the current bucket.

        Confirmed deltas rebuild affected buckets, while the active bucket's
        confirmed minutes are updated through indexed input deltas.
        """
        from sqlalchemy import select

        from .composite_chart import chart_page
        from .composite_series import read_window
        from .storage import CompositeMinuteInput, RealtimeMapping

        key = (revision.id, frame, count)
        cached = self.pages.get(key)
        from .live_window import lower_bound

        if revision.seam < lower_bound(stamp):
            cached = None  # Re-read the tail after its availability boundary moved.
        phase = revision.rules["aggregation_calendar"]
        valid = (version.manifest["checksum"], revision.rules)
        if not cached or cached[0] != valid or cached[1] > prep.input_revision:
            base = chart_page(db, composite.id, frame, count=count, revision_id=revision.id,
                input_revision=prep.input_revision, now=stamp, permission_scope=permission_scope)
        else:
            base = copy.deepcopy(cached[2])
            if cached[1] < prep.input_revision:
                floor = base["bars"][0]["start"] if len(base["bars"]) >= count else period(revision.seam, frame, phase)[0]
                affected = set(period(at, frame, phase) for at in db.scalars(select(CompositeMinuteInput.start).where(
                    CompositeMinuteInput.revision_id == revision.id,
                    CompositeMinuteInput.input_revision > cached[1],
                    CompositeMinuteInput.input_revision <= prep.input_revision,
                    CompositeMinuteInput.start >= floor)))
                for left, right in sorted(affected):
                    existing = self.items.get((revision.id, frame))
                    current_cache = self if existing and existing[2].left == left else None
                    updated = read_window(db, composite.id, frame, left, right, revision_id=revision.id,
                        now=stamp, permission_scope=permission_scope, realtime=current_cache)["bars"]
                    base["bars"] = sorted([bar for bar in base["bars"] if bar["start"] != left] + updated,
                                          key=lambda bar: bar["start"])[-count:]
            # Completion of a fixed history period artifact is independent of
            # confirmed tail input. Retry a pending baseline until it exists.
            if base.get("pending"):
                base = chart_page(db, composite.id, frame, count=count, revision_id=revision.id,
                    input_revision=prep.input_revision, now=stamp, permission_scope=permission_scope)
        base.update(input_revision=prep.input_revision, preparation_status=prep.status,
                    queried_cutoff=prep.cutoff, current_observed_confirmed_end=prep.confirmed_end)
        self.pages.pop(key, None)
        self.pages[key] = (valid, prep.input_revision, copy.deepcopy(base))
        while len(self.pages) > self.limit or sum(len(item[2]["bars"]) for item in self.pages.values()) > 16000:
            self.pages.pop(next(iter(self.pages)))
        mapping = db.get(RealtimeMapping, revision.mapping_id)
        from .display_observations import read as observed_rows

        observations = display_snapshot.content['observations'] if display_snapshot else observed_rows(
            db, mapping.target_dataset_id, revision.id, prep.input_revision,
            max(revision.seam, lower_bound(stamp)), stamp + 1)
        observations = [row for row in observations if row["start"] >= lower_bound(stamp)]
        candidates = [row['start'] for row in observations]
        # Also refresh the last confirmed bucket's time closure without a quote.
        if base["bars"] and not base["bars"][-1]["time_closed"]:
            candidates.append(base["bars"][-1]["start"])
        for left, right in sorted({period(at, frame, phase) for at in candidates}):
            updated = read_window(db, composite.id, frame, left, right, revision_id=revision.id,
                provisional=True, now=stamp, permission_scope=permission_scope, realtime=self, display_snapshot=display_snapshot)["bars"]
            base["bars"] = sorted([bar for bar in base["bars"] if bar["start"] != left] + updated,
                                  key=lambda bar: bar["start"])[-count:]
        # Every output carries the current fixed input credential, including
        # otherwise unchanged bars and provenance from the confirmed baseline.
        for bar in base["bars"]:
            bar["input_revision"] = prep.input_revision
            for segment in bar["segments"]:
                if segment["segment"] == "target":
                    segment["input"]["input_revision"] = prep.input_revision
        if display_snapshot:
            base['display_snapshot_id'] = display_snapshot.id
            if display_snapshot.content.get('degraded'):
                base['pending'] = [*base.get('pending', []),
                    '待确认观测容量已满，已保留现有图表并暂停追加；确认补齐后恢复']
        return base
