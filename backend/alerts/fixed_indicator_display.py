"""Exact bounded foreground replay over shared immutable fixed inputs.

The persistent worker remains responsible for durable completion. This uses its
same calculation function outside the request transaction, with no new engine.
Input/result storage shares the provider engine's existing global cache budgets.
"""

import json
from time import perf_counter
from types import SimpleNamespace

from . import fixed_indicators as jobs
from .indicator_state import IndicatorState, presentation
from .provider_indicator_inputs import (
    _INPUTS,
    _RESULTS,
    MAX_ROWS,
    MAX_VALUES,
    Inputs,
    _entry,
    _prune,
)
from .storage import DisplaySnapshot, FixedIndicatorRun

MAX_FOREGROUND_ROWS = 6000


def prepare(db, page, body):
    """Freeze a complete, confirmed prefix or leave the bounded queue response."""
    if not body.client or not body.indicator_consumers or not page.get("bars"):
        return []
    if any(not bar.get("complete") or not bar.get("source_confirmed", True) for bar in page["bars"]):
        return []
    snapshot = db.get(DisplaySnapshot, page["display_snapshot_id"]) if page.get("display_snapshot_id") else None
    if snapshot and snapshot.content["observations"]:
        return []  # Accepted provisional chains retain the existing suffix path.
    pending = [item for item in page.get("indicators", []) if not item["calculation"].get("visible_complete")]
    if not pending:
        return []
    run = db.get(FixedIndicatorRun, pending[0]["calculation"]["run_id"])
    if page["bars"][-1]["end"] > run.target_end:
        return []
    version, revision, phase, profiles = jobs._context(db, run)
    key = (db.get_bind(), "fixed-display", version.id, page["timeframe"], run.revision_id,
           run.input_revision, run.target_end, page["origin"])
    entry = _entry(_INPUTS, key, MAX_ROWS)
    with entry.lock:
        if entry.value is False:
            return []  # Immutable over-budget prefixes must not be rescanned.
        hit = entry.value is not None
        if not hit:
            reader = SimpleNamespace(**{column.name: getattr(run, column.name) for column in run.__table__.columns})
            reader.cursor = jobs.period(version.start, run.timeframe, phase)[0]
            rows = []
            while reader.cursor < run.target_end:
                inputs = jobs.input_rows(db, reader)
                if inputs is None:
                    return []
                chunk, _, _ = inputs
                rows.extend(chunk)
                if len(rows) > MAX_FOREGROUND_ROWS:
                    entry.value, entry.weight = False, 0
                    return []
                if not chunk or chunk[-1]["end"] >= run.target_end:
                    break
                reader.cursor = chunk[-1]["end"]
            available = {row["start"] for row in rows}
            if any(bar["start"] not in available for bar in page["bars"]):
                return []
            entry.value, entry.weight = Inputs(rows, key, key, run.input_revision), len(rows)
        frozen = entry.value
    _prune(_INPUTS, MAX_ROWS)
    return [(item, db.get(FixedIndicatorRun, item["calculation"]["run_id"]), frozen,
             phase, profiles, revision.seam if revision else None, hit) for item in pending]


def complete(page, prepared):
    """Called after checkin: current-spec values plus separate durable progress."""
    for item, run, frozen, phase, profiles, seam, hit in prepared:
        key = ("fixed-display-result", frozen.identity, run.algorithm, json.dumps(run.spec, sort_keys=True))
        entry = _entry(_RESULTS, key, MAX_VALUES)
        started = perf_counter()
        with entry.lock:
            result_hit = entry.value is not None
            if not result_hit:
                entry.value = jobs.calculate_inputs(run, frozen.rows, phase, profiles, seam=seam,
                    initial_state=IndicatorState(run.spec).checkpoint(), batch=True)
                entry.weight = len(frozen.rows) * max(6, len(item["series"]))
            calculated = entry.value
        _prune(_RESULTS, MAX_VALUES)
        first, end = page["bars"][0]["start"], page["bars"][-1]["end"]
        rows = [row for row in calculated["rows"] if first <= row["start"] < end]
        display = calculated["display"]
        if display:
            display = display | {"history_complete": True, "history_revision": run.id}
        item.update(presentation(run.spec, rows, display))
        item["dependencies"] = [{key: row.get(key) for key in
            ("start", "dependency_origin", "seam_dependency", "initialized", "provisional")} for row in rows]
        status = item["calculation"]
        status.update(visible_complete=True, coverage=jobs.coverage(page["bars"]),
            display_status="complete", producer="backend", accuracy="oracle_equivalent", canonical_verified=True,
            execution={"path": "bounded-fixed-replay", "input_cache": "hit" if hit else "miss",
                       "result_cache": "hit" if result_hit else "miss",
                       "input_rows": len(frozen.rows), "calculation_steps": 0 if result_hit else len(frozen.rows),
                       "calculation_ms": round((perf_counter()-started)*1000, 2)})
    return page
