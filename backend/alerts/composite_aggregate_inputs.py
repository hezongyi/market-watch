"""One bounded worker batch of immutable metadata and fixed-input minutes."""

import copy
import time
from types import SimpleNamespace

from sqlalchemy import select

from .storage import (
    CompositeMinuteInput,
    CompositeRevision,
    HistoryVersion,
    Instrument,
    MarketComposite,
    MarketDataset,
    RealtimeMapping,
)

MAX_MINUTES = 4096


def _plain(row, fields):
    return SimpleNamespace(**{field: copy.deepcopy(getattr(row, field)) for field in fields.split()}) if row else None


class AggregateInputs:
    """No live ORM objects or transactions survive a task's build/commit.

    At most nine claims or two seconds share one exact revision/input/scope.
    Mutable preparation, coverage and task leases are always re-read normally.
    """

    def __init__(self):
        self.clear()

    def clear(self):
        self.key, self.metadata, self.window, self.delta_rows = None, None, None, {}
        self.claims, self.created = 0, time.monotonic()

    def begin(self, ownership):
        key = tuple(ownership[name] for name in ("composite_id", "revision_id", "input_revision", "permission_scope"))
        if key != self.key or self.claims >= 9 or time.monotonic() - self.created > 2:
            self.clear()
            self.key = key
        self.claims += 1

    def context(self, db):
        if self.metadata is None:
            composite = db.get(MarketComposite, self.key[0])
            revision = db.get(CompositeRevision, self.key[1])
            if not composite or not revision:
                raise ValueError("Composite unavailable")
            version = db.get(HistoryVersion, revision.history_version_id)
            mapping = db.get(RealtimeMapping, revision.mapping_id)
            target = db.get(MarketDataset, mapping.target_dataset_id)
            inst = db.get(Instrument, target.instrument_id)
            self.metadata = (
                _plain(composite, "id permission_scope active_revision_id"),
                _plain(revision, "id composite_id history_version_id mapping_id rules seam"),
                _plain(version, "id status dataset_id manifest start end"),
                _plain(mapping, "id target_dataset_id"),
                _plain(target, "id identity instrument_id volume_kind volume_unit"),
                _plain(inst, "id precision calendar_profile"),
            )
        return self.metadata

    def minutes(self, db, revision_id, start, end, *, input_revision, now, starts=None):
        from .composite_inputs import rows
        from .live_window import lower_bound

        start = max(start, lower_bound(now))
        if start >= end:
            return []
        if starts is None and self.window:
            left, right, values = self.window
            if left <= start and end <= right:
                return [row for row in values if start <= row["timestamp"] < end]
        values = list(rows(db, revision_id, start, end, input_revision=input_revision, now=now,
                           metadata=self.context(db), starts=starts))
        if starts is None and len(values) <= MAX_MINUTES:
            self.window = (start, end, values)
        return values

    def delta(self, db, revision_id, applied, value, left, right, *, now):
        from .live_window import lower_bound

        if applied not in self.delta_rows:
            changed = list(db.scalars(select(CompositeMinuteInput.start).where(
                CompositeMinuteInput.revision_id == revision_id,
                CompositeMinuteInput.input_revision > applied,
                CompositeMinuteInput.input_revision <= value).distinct().limit(MAX_MINUTES + 1)))
            if len(changed) > MAX_MINUTES:
                self.delta_rows[applied] = None
            else:
                self.delta_rows[applied] = self.minutes(db, revision_id, min(changed), max(changed) + 60000,
                    input_revision=value, now=now, starts=changed) if changed else []
        values = self.delta_rows[applied]
        return None if values is None else [row for row in values if max(left, lower_bound(now)) <= row["timestamp"] < right]
