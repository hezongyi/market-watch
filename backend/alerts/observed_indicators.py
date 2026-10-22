"""Independent chart policy over observed OHLC, never strict confirmation.

The underlying indicator formulas remain shared. Policy checkpoints and quality
dependencies are fenced by a distinct algorithm and cannot seed strict jobs.
"""

import copy
import math

from .chart_indicators import history_requirement
from .indicator_state import ALGORITHMS, IndicatorState

STRICT = "strict_confirmed_v1"
OBSERVED = "observed_display_v1"
PREFIX = "observed-v1:"
ALGORITHMS = tuple(PREFIX + algorithm for algorithm in ALGORITHMS)


def is_observed(run):
    return getattr(run, "algorithm", "") in ALGORITHMS


def engine_for(run, checkpoint=None):
    if not is_observed(run):
        return IndicatorState(run.spec, checkpoint)
    bounds = (getattr(run, "state", None) or {}).get("observed", {})
    return ObservedState(
        run.spec,
        checkpoint,
        source_start=bounds.get("source_start"),
        source_end=bounds.get("source_end"),
    )


class ObservedState:
    """Chart-only state; closed unverified observations and live preview differ."""

    def __init__(self, spec, checkpoint=None, *, source_start=None, source_end=None):
        base = IndicatorState(spec)
        self.algorithm = PREFIX + base.algorithm
        if checkpoint is not None:
            if (
                checkpoint.get("algorithm") != self.algorithm
                or checkpoint.get("input_policy") != OBSERVED
            ):
                raise ValueError("Observed checkpoint policy or algorithm mismatch")
            base = IndicatorState(spec, {**checkpoint, "algorithm": base.algorithm})
        self.engine = base
        self.spec, self.name, self.params = base.spec, base.name, base.params
        self.meta = copy.deepcopy(checkpoint.get("observed", {}) if checkpoint else {})
        if not self.meta:
            self.meta = dict(
                source_start=source_start,
                source_end=source_end,
                n=0,
                window=[],
                unverified=False,
                statistics_unverified=False,
                event_quality={},
                last_end=None,
            )
        self.last_quality = self.meta.get("last_quality", self.quality())
        self.last_initialized = False
        if self.name == "SWING_SR_V1":
            from .swing_sr import SwingState

            self.last_presentation = SwingState(self.params, self.state or None).presentation()
            self._presentation_quality()

    def _presentation_quality(self):
        self.last_presentation.update(
            input_policy=OBSERVED,
            input_quality=self.last_quality,
            current_quality=copy.deepcopy(self.meta["event_quality"]),
            statistics_quality="unverified" if self.meta["statistics_unverified"] else "verified",
        )

    @property
    def state(self):
        return self.engine.state

    def checkpoint(self):
        return {
            **self.engine.checkpoint(),
            "algorithm": self.algorithm,
            "input_policy": OBSERVED,
            "observed": copy.deepcopy(self.meta),
        }

    def quality(self, *, provisional=False, reason=None):
        required = history_requirement(self.spec) + 1
        if self.name == "EMA":
            required = self.params["period"]
        elif self.name in ("RSI", "ATR"):
            required = self.params["period"] + 1
        elif self.name == "MACD":
            required = self.params["slow"] + self.params["signal"] - 1
        return {
            "coverage": "unverified"
            if self.meta["unverified"]
            or self.name == "SWING_SR_V1"
            and self.meta["statistics_unverified"]
            else "verified",
            "provisional": provisional,
            "dependency_origin": self.engine.state.get("origin"),
            "sample_size": self.meta["n"],
            "required_samples": required,
            "reason_code": reason,
        }

    def initialized(self, values):
        if self.name == "SWING_SR_V1":
            return self.last_quality["sample_size"] >= self.last_quality["required_samples"]
        return self.last_initialized

    def step(self, row, *, provisional=False):
        if provisional:
            trial = ObservedState(self.spec, self.checkpoint())
            values = trial._advance(row, forming=True)
            self.last_quality = trial.last_quality
            self.last_initialized = trial.last_initialized
            if hasattr(trial, "last_presentation"):
                self.last_presentation = trial.last_presentation
            return values
        return self._advance(row)

    def _advance(self, row, *, forming=False):
        m = self.meta
        partial = (
            m["source_start"] is not None
            and row["start"] < m["source_start"]
            or m["source_end"] is not None
            and row["end"] > m["source_end"]
        )
        try:
            prices = [float(row[key]) for key in ("open", "high", "low", "close")]
            valid = all(math.isfinite(value) for value in prices)
            open_, high, low, close = prices
            valid = valid and low <= min(open_, close) <= max(open_, close) <= high
        except (KeyError, TypeError, ValueError, OverflowError):
            valid = False
        valid = valid and not row.get("unavailable") and not row.get("corrupt")
        admitted = valid and not partial and (forming or row.get("time_closed", True))
        gap = bool(row.get("gap_before"))
        uncertain = not row.get("complete", False) or gap
        if not admitted:
            m.update(n=0, window=[], unverified=False, event_quality={})
            reason = (
                "PARTIAL_PERIOD"
                if partial
                else "INVALID_PRICE"
                if not valid
                else "INPUT_RECOVERING"
            )
        else:
            m["n"] += 1
            m["window"].append(uncertain)
            finite = self.name in ("SMA", "LWMA", "BBANDS", "STOCH")
            length = (
                history_requirement(self.spec) + 1
                if finite
                else 2 * max(self.params.values()) + 1
                if self.name == "SWING_SR_V1"
                else 1
            )
            del m["window"][:-length]
            m["unverified"] = any(m["window"]) if finite else m["unverified"] or uncertain
            m["statistics_unverified"] |= uncertain
            reason = "UNKNOWN_INPUT_GAP" if gap else None
        # This is an isolated algorithm input. The source bar and strict run
        # retain their original complete/coverage flags and checksum.
        effective = {**row, "complete": admitted, "gap_before": not admitted}
        if forming and self.name == "SWING_SR_V1" and admitted:
            values = self.engine.display_step(effective, provisional_dependency=True)
        else:
            values = self.engine.step(effective)
        m["last_end"] = row["end"]
        self.last_quality = self.quality(provisional=forming, reason=reason)
        self.last_initialized = admitted and self.engine.initialized(values)
        m["last_quality"] = self.last_quality
        if hasattr(self.engine, "last_presentation"):
            self.last_presentation = copy.deepcopy(self.engine.last_presentation)
            for side, event in self.last_presentation["current"].items():
                if (
                    event
                    and m["event_quality"].get(side, {}).get("pivot_time") != event["pivot_time"]
                ):
                    m["event_quality"][side] = {
                        "pivot_time": event["pivot_time"],
                        "coverage": "unverified"
                        if any(m["window"][-2 * self.params[side + "_strength"] - 1 :])
                        else "verified",
                    }
            self._presentation_quality()
        return values


def calculate(run, rows, phase, profiles, *, seam=None, initial_state=None):
    from .fixed_indicators import gap_before
    from .series_access import fixed_label

    engine = engine_for(run, run.state if initial_state is None else initial_state)
    output = []
    for source in rows:
        previous = engine.meta["last_end"]
        row = {
            **source,
            "gap_before": gap_before(previous, source["start"], phase, profiles),
            "chart_time": fixed_label(source, run.timeframe, phase),
        }
        if seam is not None and previous is not None and previous <= seam <= row["start"]:
            row["seam_at_start"] = True
        values = engine.step(row)
        output.append(output_row(engine, row, values))
    return {
        "rows": output,
        "state": engine.checkpoint(),
        "display": getattr(engine, "last_presentation", None),
    }


def output_row(engine, row, values, *, provisional=False):
    return {
        "start": row["start"],
        "end": row["end"],
        "values": values,
        "dependency_origin": engine.last_quality["dependency_origin"],
        "seam_dependency": engine.state.get("seam", False),
        "initialized": engine.initialized(values),
        "input_quality": dict(engine.last_quality),
        **({"provisional": True} if provisional else {}),
        **(
            {"break_before": True}
            if engine.last_quality["reason_code"] in ("INVALID_PRICE", "PARTIAL_PERIOD")
            else {}
        ),
    }


def status(rows, *, complete):
    """Calculation completion and input quality are independent contracts."""
    qualities = [row["input_quality"] for row in rows if "input_quality" in row]
    quality = dict(qualities[-1]) if qualities else {"coverage": "unverified", "provisional": False}
    quality["coverage"] = (
        "unverified"
        if any(q["coverage"] == "unverified" for q in qualities)
        else quality["coverage"]
    )
    quality["provisional"] = any(q["provisional"] for q in qualities)
    initialized = any(row.get("initialized") for row in rows)
    value_status = "preparing" if not complete else "ready" if initialized else "insufficient_input"
    reason = None if initialized else quality.get("reason_code") or "WARMUP_REQUIRED"
    if not complete:
        reason = None
    elif quality.get("reason_code") == "INVALID_PRICE":
        value_status, reason = "unavailable", "INVALID_PRICE"
    return dict(
        input_policy=OBSERVED,
        value_status=value_status,
        reason_code=reason,
        input_quality=quality,
        accuracy="observed_sequence_exact",
        canonical_verified=False,
    )


def chart_result(db, page, spec, run, *, provisional, stamp):
    from . import fixed_indicators as jobs
    from .indicator_state import presentation

    first, end = page["bars"][0]["start"], page["bars"][-1]["end"]
    rows = jobs.outputs(db, run, first, min(end, run.cursor))
    engine = engine_for(run, run.state)
    display = getattr(engine, "last_presentation", None)
    if run.status == "complete" and run.revision_id and provisional:
        repaired = suffix(db, run, page, stamp=stamp)
        if repaired:
            affected, extra, display = repaired
            rows = [row for row in rows if row["start"] < affected]
            rows += [row for row in extra if first <= row["start"] < end]
    if display:
        display = {
            **display,
            "history_complete": run.status == "complete",
            "history_revision": run.id,
        }
    available = {row["start"] for row in rows}
    visible_complete = all(bar["start"] in available for bar in page["bars"])
    progress = dict(
        id=spec.get("id", spec["name"]),
        run_id=run.id,
        status=run.status
        if run.status == "complete" or run.cursor <= page["origin"]
        else "partial",
        cursor=run.cursor,
        target_end=run.target_end,
        input_revision=run.input_revision,
        algorithm=run.algorithm,
        error=run.error,
        next_at=run.next_at,
        parent_run_id=run.parent_id,
        reused_prefix_end=run.prefix_end,
        calculation_origin=page["origin"],
        producer="backend",
        visible_complete=visible_complete,
        coverage=jobs.coverage(rows),
        required_coverage=jobs.coverage(page["bars"]),
        input_evidence={
            "revision_id": run.revision_id,
            "input_revision": run.input_revision,
            "history_version_id": run.history_version_id,
            "display_snapshot_id": page.get("display_snapshot_id"),
            "input_policy": OBSERVED,
        },
        display_task_ids=[],
        execution={
            "path": "durable-observed",
            "result_cache": "hit" if run.status == "complete" else "checkpoint",
            "calculation_steps": 0,
        },
        **status(rows, complete=visible_complete),
    )
    return (
        {
            **presentation(spec, rows, display),
            "id": progress["id"],
            "calculation": progress,
            "dependencies": [
                {
                    key: row.get(key)
                    for key in (
                        "start",
                        "dependency_origin",
                        "seam_dependency",
                        "initialized",
                        "provisional",
                        "input_quality",
                    )
                }
                for row in rows
            ],
        },
        progress,
    )


def suffix(db, run, page, *, stamp):
    """Replay only snapshot observations/current buckets after a compatible seed.

    Closed coverage-only uncertainty already belongs to the independent durable
    run; it must not force a replay from the first imperfect historical bucket.
    Never put policy checkpoints in legacy display tasks: old workers do not
    filter those tasks by supported algorithm when the application rolls back.
    """
    from . import fixed_indicators as jobs
    from .composite_chart import chart_page
    from .series_access import fixed_label
    from .storage import CompositeRevision

    revision = db.get(CompositeRevision, run.revision_id)
    snapshot = None
    if page.get("display_snapshot_id"):
        from .display_snapshots import resolve

        snapshot = resolve(db, page["display_snapshot_id"], revision, run.timeframe, stamp)
    phase = revision.rules["aggregation_calendar"]
    observed = snapshot.content["observations"] if snapshot else []
    affected = [jobs.period(row["start"], run.timeframe, phase)[0] for row in observed]
    latest = chart_page(
        db,
        page["composite_id"],
        run.timeframe,
        count=1,
        revision_id=run.revision_id,
        provisional=True,
        now=stamp,
        display_snapshot=snapshot,
    )
    if latest["input_revision"] != run.input_revision:
        from .display_snapshots import DisplaySnapshotError

        raise DisplaySnapshotError(
            "DISPLAY_SNAPSHOT_EXPIRED", "价格快照与指标输入不一致，请重新读取价格"
        )
    tail = latest["bars"]
    affected.extend(bar["start"] for bar in tail if bar["end"] > run.target_end)
    if not affected:
        return None
    affected = min(affected)
    safe = jobs.checkpoint_before(db, run, affected)
    cursor, checkpoint = safe if safe else (page["origin"], None)
    engine = engine_for(run, checkpoint)
    end = max(run.target_end, tail[-1]["end"] if tail else run.target_end)
    before, inputs = end, {}
    for _ in range(2):
        part = chart_page(
            db,
            page["composite_id"],
            run.timeframe,
            before=before,
            count=2000,
            revision_id=run.revision_id,
            provisional=True,
            now=stamp,
            display_snapshot=snapshot,
        )
        inputs.update((bar["start"], bar) for bar in part["bars"] if cursor <= bar["start"] < end)
        if not part["bars"] or part["bars"][0]["start"] <= cursor or not part["has_more"]:
            break
        before = part["next_before"]
    else:
        from .display_snapshots import DisplaySnapshotError

        raise DisplaySnapshotError(
            "DISPLAY_SUFFIX_CAPACITY_EXCEEDED", "展示依赖超过4000根，等待确认输入收敛后重试"
        )
    _, _, _, profiles = jobs._context(db, run)
    output = []
    for bar in sorted(inputs.values(), key=lambda row: row["start"]):
        row = {
            **bar,
            "gap_before": jobs.gap_before(engine.meta["last_end"], bar["start"], phase, profiles),
            "chart_time": fixed_label(bar, run.timeframe, phase),
        }
        forming = bar["end"] > (snapshot.content["now"] if snapshot else stamp)
        values = engine.step(row, provisional=forming)
        if row["start"] >= affected:
            output.append(output_row(engine, row, values, provisional=forming))
    return affected, output, getattr(engine, "last_presentation", None)
