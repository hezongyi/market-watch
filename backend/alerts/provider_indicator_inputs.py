"""Freeze coherent provider inputs, then share bounded, restartable Python calculations.

Caches are process-local accelerators. Their absence changes cost, never the fixed
origin or revision being calculated. Database mutations fence retained prefixes.
"""

import bisect
import json
import threading
from collections import OrderedDict
from dataclasses import dataclass, field

from sqlalchemy import func, select

from .chart_calculation_history import calculation_rows
from .chart_indicators import CATALOG, calculate, validate
from .indicator_state import SUPPORTED, IndicatorState, presentation
from .provider_history_policy import CapacityExceeded
from .storage import ProviderBar, ProviderDataset

_LOCK = threading.Lock()
_INPUTS = OrderedDict()
_RESULTS = OrderedDict()
MAX_ROWS = 250_000
MAX_VALUES = 1_500_000


@dataclass
class Inputs:
    rows: list
    identity: tuple
    epoch: object
    revision: int


@dataclass
class Entry:
    lock: threading.Lock = field(default_factory=threading.Lock)
    value: object = None
    weight: int = 0


def _prune(cache, maximum):
    with _LOCK:
        while cache and (len(cache) > 16 or sum(item.weight for item in cache.values()) > maximum):
            cache.popitem(last=False)


def _entry(cache, key, maximum):
    with _LOCK:
        entry = cache.setdefault(key, Entry())
        cache.move_to_end(key)
        # A caller retains its entry even when pressure evicts it. The entry
        # contains no global state and cannot corrupt a replacement flight.
        while len(cache) > 16 or sum(item.weight for item in cache.values()) > maximum:
            if len(cache) == 1:
                break
            cache.popitem(last=False)
        return entry


def freeze(db, page, body, maximum, *, evaluation_end=None, telemetry=None):
    """Called inside the visible page's repeatable-read transaction, never computes."""
    from .provider_cache import check_cancelled

    stats = telemetry if telemetry is not None else {}
    stats.update(input_cache='miss', sql_payload_rows=0)
    dataset = db.get(ProviderDataset, page["dataset_id"])
    origin = body.calculation_origin or 0
    swing = any(s["name"] == "SWING_SR_V1" for s in body.indicators)
    ceiling = page["bars"][-1]["start"]
    if swing:
        tail = page.get("_snapshot_tail")
        ceiling = tail["start"] if tail else dataset.metadata_json.get("indicator_tail_start")
        if ceiling is None:
            ceiling = db.scalar(select(func.max(ProviderBar.start)).where(ProviderBar.dataset_id == dataset.id))
        if evaluation_end is not None:
            ceiling = evaluation_end
    identity = (db.get_bind(), dataset.id, origin)
    revision = dataset.revision
    # A restored pre-patch dataset has no mutation epoch yet. Its exact
    # revision is still immutable within this observation, so share that
    # revision only; the next legacy write forces a complete reload.
    epoch = dataset.metadata_json.get("indicator_history_epoch") or (
        "legacy", revision, dataset.updated_at)
    entry = _entry(_INPUTS, identity, MAX_ROWS)
    # Hold no second connection while sharing a frozen prefix. The first
    # caller does only DB I/O/decoding here; numerical work follows checkin.
    while not entry.lock.acquire(timeout=0.05):
        check_cancelled()
    try:
        previous = entry.value
        same = (previous is not None and previous.epoch == epoch and epoch is not None
                and previous.revision <= revision)
        # With an unchanged mutation epoch, only the retained final row can
        # have changed. A window ending strictly before it remains immutable
        # even while the live writer advances the dataset revision.
        prefix_unchanged = same and previous.rows and previous.rows[-1]["start"] > ceiling
        if prefix_unchanged or same and previous.revision == revision and (not previous.rows or
                previous.rows[-1]["start"] >= ceiling):
            rows = previous.rows
            stats['input_cache'] = 'hit'
        else:
            # Every commit changing an earlier row rotates the history epoch.
            # Re-read the last retained row, which can still be forming.
            incremental = same and previous.rows and previous.rows[-1]["start"] <= ceiling
            left = previous.rows[-1]["start"] if incremental else origin
            loaded = list(db.scalars(select(ProviderBar.payload).where(
                ProviderBar.dataset_id == dataset.id, ProviderBar.start >= left,
                ProviderBar.start <= ceiling).order_by(ProviderBar.start).limit(maximum + 1)))
            stats.update(input_cache='append' if incremental else 'miss', sql_payload_rows=len(loaded))
            check_cancelled()
            rows = [*previous.rows[:-1], *loaded] if incremental else loaded
            if len(rows) > maximum:
                raise CapacityExceeded(f"指标固定前缀超过历史容量 {maximum:,} 根，请调整容量后重试")
            if rows and body.calculation_origin is not None and rows[0]["start"] != origin:
                raise ValueError("指标固定历史起点缺失，请刷新并核对数据集")
            value = Inputs(rows, identity, epoch, revision)
            if previous is None or revision >= previous.revision:
                entry.value, entry.weight = value, len(rows)
        end = bisect.bisect_right(rows, ceiling, key=lambda row: row["start"])
        if end > maximum:
            raise CapacityExceeded(f"指标固定前缀超过历史容量 {maximum:,} 根，请调整容量后重试")
        # Preserve the same list for repeated complete-prefix reads. Its rows
        # are immutable values decoded in this observation, never ORM entities.
        rows = rows if end == len(rows) else rows[:end]
        tail = page.get("_snapshot_tail")
        if tail is not None and rows and rows[-1]["start"] == tail["start"]:
            rows = [*rows[:-1], tail]
        return Inputs(rows, identity, epoch, page.get("cache_revision", revision))
    finally:
        entry.lock.release()
        _prune(_INPUTS, MAX_ROWS)


def compute(inputs, meta, instrument, spec, *, first, provisional, telemetry=None):
    """Share one immutable input calculation, including its confirmed checkpoints."""
    from .provider_cache import check_cancelled

    name, params = validate(spec)
    stats = telemetry if telemetry is not None else {}
    rows = inputs.rows
    from .storage import now_ms

    stats.update(result_cache='miss', input_rows=len(rows), calculation_steps=0, checkpoint_index=0,
                 input_accepted_at_ms=now_ms())
    key = (inputs.identity, name, json.dumps(params, sort_keys=True),
           json.dumps(meta.get("calendar_profile"), sort_keys=True), meta["calendar"], instrument)
    if name == "SWING_SR_V1" or name not in SUPPORTED:
        key = ("batch", key, inputs.epoch, inputs.revision, provisional,
               json.dumps(rows[-1], sort_keys=True) if rows else "")
        entry = _entry(_RESULTS, key, MAX_VALUES)
        while not entry.lock.acquire(timeout=0.05):
            check_cancelled()
        try:
            if entry.value is None:
                check_cancelled()
                result = calculate(calculation_rows(rows, meta, instrument), spec, provisional=provisional)
                check_cancelled()
                entry.value, entry.weight = result, len(rows) * max(6, len(CATALOG[name]["series"]))
                stats['calculation_steps'] = len(rows)
            else:
                stats['result_cache'] = 'hit'
            result = entry.value
            return {**result, "series": [{**s, "values": [v for v in s["values"] if v["time"] >= first]}
                                         for s in result["series"]]}
        finally:
            entry.lock.release()
            _prune(_RESULTS, MAX_VALUES)
    entry = _entry(_RESULTS, key, MAX_VALUES)
    while not entry.lock.acquire(timeout=0.05):
        check_cancelled()
    try:
        previous = entry.value
        reusable = (previous is not None and inputs.epoch is not None
                    and previous[0].epoch == inputs.epoch)
        if reusable and previous[0].rows is rows:
            values, checkpoints = previous[1:]
            stats['result_cache'] = 'hit'
        else:
            # Checkpoints precede the mutable tail. Historical corrections and
            # backfills use a different epoch and replay from the fixed origin.
            common = min(len(previous[0].rows), len(rows)) - 1 if reusable else 0
            checkpoints = previous[2] if reusable else {}
            index = max((i for i in checkpoints if i <= common), default=0)
            stats.update(result_cache='checkpoint' if index else 'miss', checkpoint_index=index)
            state = IndicatorState(spec, checkpoints.get(index))
            values = list(previous[1][:index]) if reusable else []
            checkpoints = {i: value for i, value in checkpoints.items() if i <= index}
            prepared = calculation_rows(rows[max(0, index-1):], meta, instrument)
            if index:
                prepared = prepared[1:]
            for offset, row in enumerate(prepared, index):
                stats['calculation_steps'] += 1
                if offset % 512 == 0:
                    check_cancelled()
                    checkpoints[offset] = state.checkpoint()
                # Preview is isolated at presentation time. Historical missing
                # bars reset the confirmed state just like the batch engine.
                values.append(state.step(row))
            check_cancelled()
            if previous is None or inputs.revision >= previous[0].revision:
                entry.value = (inputs, values, checkpoints)
                entry.weight = len(values) * max(6, len(CATALOG[name]["series"]))
        start = bisect.bisect_left(rows, first, key=lambda row: row["start"])
        rendered = [{"start": row["start"], "values": values[i],
                     **({"break_before": True} if row.get("gap_before") else {})}
                    for i, row in enumerate(rows[start:], start)]
        # The calculated segmentation can add a trading-gap break absent from
        # the raw provider row. Preserve that presentation contract too.
        prepared_visible = calculation_rows(rows[max(0, start-1):], meta, instrument)
        if start:
            prepared_visible = prepared_visible[1:]
        for target, source in zip(rendered, prepared_visible):
            if source.get("gap_before"):
                target["break_before"] = True
        if provisional and rows and not rows[-1]["complete"] and rendered:
            index = max((i for i in checkpoints if i <= len(rows)-1), default=0)
            state = IndicatorState(spec, checkpoints.get(index))
            tail = calculation_rows(rows[max(0, index-1):], meta, instrument)
            if index:
                tail = tail[1:]
            for row in tail[:-1]:
                state.step(row)
            rendered[-1]["values"] = state.step(tail[-1], provisional=True)
            rendered[-1]["provisional"] = True
        result = presentation(spec, rendered)
        return {**result, "series": [{"key": s["key"], "type": s["type"], "values": s["values"]}
                                     for s in result["series"]]}
    finally:
        entry.lock.release()
        _prune(_RESULTS, MAX_VALUES)
