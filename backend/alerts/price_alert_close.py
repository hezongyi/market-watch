"""Bounded sequential consumption of the existing fixed composite aggregates."""

import copy
import hashlib
import json
from dataclasses import asdict
from decimal import Decimal

from sqlalchemy import and_, func, or_, select

from .chart_alert_domain import EvaluationState, Observation
from .chart_alert_execution import transition
from .composite_series import period
from .price_alert_confirmation import covered, facts, failure
from .price_alert_evaluator import CONTRACT, right_value
from .storage import (
    Audit,
    CompositeAggregateBar,
    CompositeAggregateTask,
    CompositeJudgment,
    CompositeMinuteInput,
    CompositeReadAttempt,
    CompositeRevision,
    Instrument,
    LiveMinute,
    MarketDataset,
)

BATCH_SIZE = 128
# Steady-state confirmation is scheduled once per M1, plus its source margin.
CONFIRMATION_INTERVAL_MS = 60000


def bars(db, revision, frame, value, *, start, end, newest=False):
    """Read a published fixed version without imposing the chart's seam gate."""
    model = CompositeAggregateBar
    latest = select(model.start, func.max(model.input_revision).label("value")).where(
        model.revision_id == revision.id, model.timeframe == frame,
        model.input_revision <= value, model.start >= start, model.start < end
    ).group_by(model.start).subquery()
    query = select(model).join(latest, and_(model.start == latest.c.start,
        model.input_revision == latest.c.value)).where(model.revision_id == revision.id,
        model.timeframe == frame).order_by(model.start.desc() if newest else model.start).limit(BATCH_SIZE)
    return list(db.scalars(query))


def window_reason(db, revision, target, value, fact, start, end, *, row=None, settlement=None):
    """Query completion and observed-but-unconfirmed input are separate facts."""
    unreadable = fact.get("unreadable_failure")
    if unreadable and unreadable[0] < end and start < unreadable[1]:
        return "confirmation_window_unreadable"
    if failure(fact, start, end):
        return "confirmation_query_failed"
    observations = select(LiveMinute.id).where(LiveMinute.dataset_id == target.id,
            LiveMinute.start >= start, LiveMinute.start < end,
            LiveMinute.expected.is_(True))
    observations = observations.where(or_(LiveMinute.confirmed_at.is_(None),
        LiveMinute.confirmed_at > settlement["started_at"]), LiveMinute.first_attempt <= settlement["started_at"]
        ) if settlement else observations.where(LiveMinute.confirmed_at.is_(None))
    if db.scalar(observations.limit(1)) is not None:
        return "observed_minute_unconfirmed"
    newer = select(CompositeMinuteInput.start).where(
            CompositeMinuteInput.revision_id == revision.id, CompositeMinuteInput.start >= start,
            CompositeMinuteInput.start < end, CompositeMinuteInput.input_revision > value)
    if settlement:
        newer = newer.where(CompositeMinuteInput.input_revision <= settlement["known_input_revision"])
    if db.scalar(newer.limit(1)) is not None:
        return "confirmation_aggregation_pending"
    proof = row.data.get("price_input_read", {}) if row else {}
    if not covered(fact, start, end) and not proof.get("query_covered"):
        # Old accepted preparation reads already carry a bounded source proof.
        cursor = start
        attempts = select(CompositeReadAttempt.start, CompositeReadAttempt.checkpoint)
        attempts = attempts.where(CompositeReadAttempt.finished_at <= settlement["started_at"]) if settlement else attempts
        for lower, upper in db.execute(attempts
                .where(CompositeReadAttempt.revision_id == revision.id,
                    CompositeReadAttempt.accepted.is_(True), CompositeReadAttempt.start < end,
                    CompositeReadAttempt.checkpoint > start).order_by(CompositeReadAttempt.start)):
            if lower > cursor:
                break
            cursor = max(cursor, upper)
            if cursor >= end:
                break
        if cursor < end:
            return "confirmation_window_pending"
    if row:
        from .live_window import lower_bound

        # A materialized monthly bucket can outlive the live window, but it
        # must have been built before its earliest required minute was trimmed.
        read_start = proof.get("target_start", max(start, lower_bound(row.created_at)))
        if read_start > start:
            return "confirmation_window_unreadable"
        if not row.data.get("source_confirmed"):
            return "observed_minute_unconfirmed"
    return None


def evidence(identity, revision, row, value, previous):
    bar = copy.deepcopy(row.data)
    bar["input_revision"] = value
    bar["time_closed"] = True
    bar["complete"] = bool(bar["source_confirmed"] and bar["coverage_complete"])
    return {"contract": CONTRACT, "bar": bar, "previous_state": previous,
        "observation_basis": "confirmed_close", "input_manifest": {
            "history_version_id": identity["history_version_id"], "history_checksum": identity["history_checksum"],
            "composite_revision_id": revision.id, "input_revision": value, "mapping_id": revision.mapping_id,
            "rules": revision.rules, "seam": revision.seam}}


def judgment(db, alert, version, revision, row, value, detail, outcome, now, signal=None):
    key = hashlib.sha256(json.dumps([version.id, alert.run, row.start, value, outcome]).encode()).hexdigest()
    if not db.get(CompositeJudgment, key):
        db.add(CompositeJudgment(id=key, alert_version_id=version.id, revision_id=revision.id,
            history_version_id=revision.history_version_id, input_revision=value, event_time=row.data["end"],
            outcome=outcome, signal_id=signal.id if signal else None, created_at=now,
            evidence={**detail, "rule_version": alert.version, "rule": version.config}))


def initialize_close(db, alert, identity, config, *, now, takeover=False):
    from .chart_alert_service import current_version

    revision = db.get(CompositeRevision, identity["composite_revision_id"])
    target = db.get(MarketDataset, identity["target_dataset_id"])
    task = db.get(CompositeAggregateTask, (revision.id, config.timeframe))
    value = task.applied_input_revision if task else -1
    fact = facts(db, target.identity)
    boundary = period(now, config.timeframe, revision.rules["aggregation_calendar"])[0]
    alert.runtime = {**alert.runtime, "execution_contract": CONTRACT, "close_cursor": boundary,
        "composite_revision_id": revision.id, "baseline_at": now,
        "needs_baseline": True, "processed_input_revision": value}
    for row in bars(db, revision, config.timeframe, value, start=revision.seam, end=boundary, newest=True):
        bar = row.data
        if bar["end"] > now or bar.get("mixed_source") or window_reason(
                db, revision, target, value, fact, row.start, bar["end"], row=row):
            continue
        right = right_value(config)
        alert.state = asdict(EvaluationState(sequence=bar["end"], left=bar["close"],
            right=str(right) if right is not None else None, count=alert.count))
        alert.runtime = {**alert.runtime, "needs_baseline": False, "last_start": row.start,
            "last_input_at": bar["end"], "baseline_price": bar["close"]}
        detail = evidence(identity, revision, row, value, {})
        judgment(db, alert, current_version(db, alert), revision, row, value, detail, "initial_baseline", now)
        break
    transition(db, alert, state="preparing", now=now, reason="awaiting_worker", checked=False)
    db.add(Audit(kind="chart_alert_baseline", at=now, details={"alert_id": alert.id,
        "version": alert.version, "run": alert.run, "effective_at": alert.effective_at,
        "cursor": boundary, "price": alert.state.get("left"), "takeover": takeover}))


def corrections(db, alert, revision, target, config, value, fact, now, *, settlement=None):
    previous = alert.runtime.get("processed_input_revision", value)
    cursor = alert.runtime["close_cursor"]
    last_start = alert.runtime.get("last_start")
    newer = select(CompositeMinuteInput.start).where(
            CompositeMinuteInput.revision_id == revision.id, CompositeMinuteInput.start >= last_start,
            CompositeMinuteInput.start < alert.state["sequence"], CompositeMinuteInput.input_revision > value
        ) if last_start is not None else None
    if newer is not None and settlement:
        newer = newer.where(CompositeMinuteInput.input_revision <= settlement["known_input_revision"])
    if newer is not None and db.scalar(newer.limit(1)) is not None:
        return "confirmation_aggregation_pending"
    if value <= previous:
        return
    first, last = db.execute(select(func.min(CompositeMinuteInput.start), func.max(CompositeMinuteInput.start))
        .where(CompositeMinuteInput.revision_id == revision.id,
            CompositeMinuteInput.input_revision > previous, CompositeMinuteInput.input_revision <= value,
            CompositeMinuteInput.start < cursor)).one()
    if first is not None:
        details = {"alert_id": alert.id, "version": alert.version, "run": alert.run,
            "start": first, "end": last + 60000, "previous_input_revision": previous, "input_revision": value}
        if last_start is not None and last >= last_start:
            rows = bars(db, revision, config.timeframe, value, start=last_start, end=last_start + 1)
            if rows:
                reason = window_reason(db, revision, target, value, fact, last_start, rows[0].data["end"],
                    row=rows[0], settlement=settlement)
                if reason:
                    return reason
            if rows and rows[0].data["close"] != alert.state.get("left"):
                details.update(previous_price=alert.state.get("left"), revised_price=rows[0].data["close"])
                alert.state = {**alert.state, "left": rows[0].data["close"]}
                alert.runtime = {**alert.runtime, "baseline_price": rows[0].data["close"]}
        db.add(Audit(kind="chart_alert_input_revision", at=now, details=details))
    alert.runtime = {**alert.runtime, "processed_input_revision": value}


def evaluate_close(db, alert, version, config, now, *, clock=None):
    from .chart_alert_service import consume
    from .composite_alerts import bound_identity
    from .composite_quotes import live_snapshot
    from .live_session import session_status, unclosed_milliseconds
    from .live_window import lower_bound
    from .price_alert_evaluator import eligibility
    from .price_alert_settlement import begin, finish, pending, runnable

    try:
        revision, target = bound_identity(db, version.market_identity)
        eligibility(db, revision, mode="close", now=now)
    except ValueError as exc:
        transition(db, alert, state="blocked", now=now, reason=getattr(exc, "reason_code", "binding_changed"))
        return []
    if clock:
        now = clock()
    begin(db, alert, version, config, now=now)
    if not runnable(alert):
        return []
    settlement = alert.runtime["settlement"] if pending(alert) else None
    if alert.runtime.get("execution_contract") != CONTRACT:
        # Trust only an immutable old judgment with the same version and cursor.
        trusted = db.scalar(select(CompositeJudgment).where(
            CompositeJudgment.alert_version_id == version.id,
            CompositeJudgment.event_time == alert.state.get("sequence", -1)).limit(1))
        if trusted and alert.state.get("sequence", 0) >= alert.effective_at:
            alert.runtime = {**alert.runtime, "execution_contract": CONTRACT,
                "close_cursor": alert.state["sequence"], "needs_baseline": False}
        else:
            initialize_close(db, alert, version.market_identity, config, now=now, takeover=True)
            db.add(Audit(kind="chart_alert_unobserved", at=now, details={"alert_id": alert.id,
                "version": alert.version, "run": alert.run, "reason_code": "upgrade_boundary",
                "start": alert.effective_at, "end": now, "bounds": "possible"}))
    alert.runtime = {**alert.runtime, "taken_over_at": alert.runtime.get("taken_over_at", now),
        "last_checked_at": now}
    task = db.get(CompositeAggregateTask, (revision.id, config.timeframe))
    value = settlement["input_revision"] if settlement else task.applied_input_revision if task else -1
    phase = revision.rules["aggregation_calendar"]
    cursor = alert.runtime["close_cursor"]
    cutoff = settlement["cursor_limit"] if settlement else period(now, config.timeframe, phase)[0]
    profile = db.get(Instrument, target.instrument_id).calendar_profile
    fact = settlement["query_fact"] if settlement else facts(db, target.identity)
    correction_reason = corrections(db, alert, revision, target, config, value, fact, now, settlement=settlement)
    selected = {row.start: row for row in bars(db, revision, config.timeframe, value, start=cursor, end=cutoff)}
    events, empty, reason = [], None, correction_reason
    for _ in range(BATCH_SIZE):
        if reason or cursor >= cutoff or not runnable(alert):
            break
        start, end = period(cursor, config.timeframe, phase)
        row = selected.get(start)
        if start < revision.seam:
            # Do not compare across the fixed-history/target source boundary.
            alert.runtime = {**alert.runtime, "needs_baseline": True}
            db.add(Audit(kind="chart_alert_source_boundary", at=now, details={"alert_id": alert.id,
                "version": alert.version, "run": alert.run, "start": start, "end": end}))
        else:
            reason = window_reason(db, revision, target, value, fact, start, end, row=row, settlement=settlement)
            if reason and not row and unclosed_milliseconds(target.identity, profile, start, end) == 0:
                # Verified closure does not override actual observed/failing input.
                if reason == "confirmation_window_pending":
                    reason = None
            if reason:
                if start < lower_bound(now):
                    reason = "confirmation_window_unreadable"
                break
            if row:
                if empty:
                    _empty_audit(db, alert, empty, now)
                    empty = None
                baseline = alert.runtime.get("needs_baseline", False) or not alert.state
                detail = evidence(version.market_identity, revision, row, value, copy.deepcopy(alert.state))
                signal = consume(db, alert.id, Observation(f"bar:{start}", end, end,
                    Decimal(row.data["close"]), right_value(config), Decimal(row.data["close"]), detail),
                    detected_at=now, baseline=baseline, expected_version=alert.version, settlement=bool(settlement))
                if signal:
                    events.append(signal)
                if baseline or signal:
                    judgment(db, alert, version, revision, row, value, detail,
                        "triggered" if signal else "initial_baseline", now, signal)
                alert.runtime = {**alert.runtime, "needs_baseline": False, "last_start": start,
                    "last_input_at": end, "last_evaluated_at": now, "baseline_price": row.data["close"],
                    "last_outcome": "initial_baseline" if baseline else "evaluated"}
            else:
                empty = [empty[0] if empty else start, end]
        cursor = end
        alert.runtime = {**alert.runtime, "close_cursor": cursor}
    if empty:
        _empty_audit(db, alert, empty, now)
    if settlement:
        if reason or cursor >= cutoff or alert.status == "completed":
            finish(db, alert, now=now, reason=reason, start=cursor, end=cutoff)
        else:
            transition(db, alert, state="settling", now=now)
        return events
    deadline = period(cursor, config.timeframe, phase)[1] + max(120000, 3 * CONFIRMATION_INTERVAL_MS)
    alert.runtime = {**alert.runtime, "expected_input_at": deadline}
    if reason:
        state = ("blocked" if reason == "confirmation_window_unreadable" or now >= deadline else
            "recovering" if reason == "confirmation_query_failed" else "preparing")
        transition(db, alert, state=state, now=now, reason=reason, interval={"start": cursor,
            "end": period(cursor, config.timeframe, phase)[1], "bounds": "exact"})
    elif session_status(target.identity, profile, now)["market_session"] == "closed":
        transition(db, alert, state="closed", now=now)
    else:
        view = live_snapshot(db, revision, now=now)
        if (not view["owned"] or view.get("authentication_hold")
                or view.get("connection_error") in ("unauthorized", "provider_maintenance")):
            transition(db, alert, state="recovering", now=now, reason="confirmation_source_unavailable")
        else:
            transition(db, alert, state="preparing" if alert.runtime.get("needs_baseline") else "monitoring",
                now=now, reason="awaiting_confirmed_baseline" if alert.runtime.get("needs_baseline") else None)
    return events


def _empty_audit(db, alert, span, now):
    db.add(Audit(kind="chart_alert_no_observation", at=now, details={"alert_id": alert.id,
        "version": alert.version, "run": alert.run, "start": span[0], "end": span[1]}))
