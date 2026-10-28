"""Consistent activation of a prepared composite revision, with fencing.

One transaction publishes the whole switch or none of it:

  1 capability   the candidate source keeps the running revision's contract
  2 run record   MarketSwitchRun preparing -> shadow_ready -> activating
  3 alerts       active rules re-bound at the event boundary: a rule already on
                 the candidate starts a fresh baseline, a rule left on the
                 superseded revision is paused instead of reading frozen input
  4 metrics      every frame watermark consolidated at the activation input
  5 fence        the previous revision is frozen: no live fan-out, no aggregate
                 registration, late input and aggregate commits refused
  6 activation   CompositeActivation + MarketComposite.active_revision_id
  7 succeeded    only this durable row unlocks the 30-day cleanup

A failure rolls the transaction back, then durably records one failed or partial
run plus one run-deduplicated summary message; the previous revision keeps
running and nothing unlocks the cleanup.
"""

from sqlalchemy import select

from . import composite_alerts, switch_notice, switch_source
from .composite_inputs import frozen
from .storage import (
    CompositeActivation,
    CompositeAggregateTask,
    CompositePreparation,
    CompositeRevision,
    MarketComposite,
    MarketSwitchRun,
    transaction,
)

KIND = "revision_activation"
ORDER = {"preparing": 0, "shadow_ready": 1, "activating": 2,
         "succeeded": 3, "failed": 3, "partial": 3}
PATHS = {"shadow_ready": ("shadow_ready",),
         "activating": ("shadow_ready", "activating"),
         "succeeded": ("shadow_ready", "activating", "succeeded"),
         "partial": ("shadow_ready", "activating", "partial"),
         "failed": ("failed",)}
FROZEN_REASON = "组合已切换到新修订；旧修订输入已冻结，需显式改为新修订后恢复"


def advance_to(row, state, now, *, phase=None, error_summary=None):
    """Forward-only progress on the persisted switch state machine."""
    from .switch_runs import _advance

    for step in PATHS[state]:
        if ORDER[row.state] >= ORDER[step]:
            continue
        _advance(row, step, now)
    if phase is not None:
        row.phase = phase
    if error_summary is not None:
        row.error_summary = error_summary
    return row


def open_run(db, *, composite_id, previous_revision_id, target_revision_id, scheduled_for,
             run_id=None):
    """One run identity per candidate revision; a failed run is retried in place."""
    row = None
    if run_id:
        row = db.scalar(select(MarketSwitchRun).where(
            MarketSwitchRun.id == run_id).with_for_update())
        if row is not None and row.kind != KIND:
            raise ValueError("该切换运行不是修订激活运行")
    else:
        row = db.scalar(select(MarketSwitchRun).where(
            MarketSwitchRun.kind == KIND, MarketSwitchRun.composite_id == composite_id,
            MarketSwitchRun.target_revision_id == target_revision_id,
        ).order_by(MarketSwitchRun.created_at).limit(1).with_for_update())
    if row is None:
        # A rolled-back attempt left no row: reopen it under the same identity so
        # a retry keeps the same run and therefore the same summary message.
        row = MarketSwitchRun(**({"id": run_id} if run_id else {}), kind=KIND,
            composite_id=composite_id, previous_revision_id=previous_revision_id,
            target_revision_id=target_revision_id, scheduled_for=scheduled_for,
            state="preparing")
        db.add(row)
        db.flush()
        return row
    if row.composite_id not in (None, composite_id) or row.target_revision_id not in (
            None, target_revision_id):
        raise ValueError("该切换运行已绑定其他组合或目标修订")
    row.composite_id, row.target_revision_id = composite_id, target_revision_id
    if row.previous_revision_id is None:
        row.previous_revision_id = previous_revision_id
    if row.state in ("failed", "partial"):
        row.state, row.attempts, row.finished_at = "preparing", (row.attempts or 0) + 1, None
    return row


def consolidate_metrics(db, revision, progress, *, run_id, boundary, now):
    """Rebuild the candidate checkpoints at the exact activating input."""
    from .chart_data import FRAMES
    from .composite_aggregates import request

    value = progress["input_revision"]
    if value is None:
        raise ValueError("目标修订没有可激活的固定输入水位")
    request(db, revision.id)
    tasks = {task.timeframe: task for task in db.scalars(select(CompositeAggregateTask).where(
        CompositeAggregateTask.revision_id == revision.id).with_for_update())}
    stale = [frame for frame in FRAMES if frame not in tasks
             or tasks[frame].applied_input_revision < value]
    if stale:
        raise ValueError("目标修订周期水位未覆盖激活输入：" + "、".join(stale))
    for task in tasks.values():
        # A running claim keeps its lease; only stale failure state is cleared.
        task.next_at, task.attempts, task.error, task.updated_at = 0, 0, None, now
    return {"input_revision": value, "frames": sorted(tasks),
            "indicators": [{"run_id": item.get("run_id"), "status": item.get("status")}
                           for item in progress.get("indicators", [])],
            "boundary": boundary, "run_id": run_id,
            "policy": "watermarks_consolidated_at_event_boundary"}


def freeze_previous(db, previous, *, run_id, boundary, now):
    """Fix the old waterline and refuse every late write for it."""
    prep = db.scalar(select(CompositePreparation).where(
        CompositePreparation.revision_id == previous.id).with_for_update())
    if prep is None:
        raise ValueError("旧修订缺少准备记录，不能安全冻结")
    waterline = prep.input_revision
    prep.state = {**prep.state, "revision_frozen": True, "fence": {
        "run_id": run_id, "at": now, "waterline": waterline, "boundary": boundary,
        "policy": "no_live_fanout; no_aggregate_registration; late commits refused"}}
    for task in db.scalars(select(CompositeAggregateTask).where(
            CompositeAggregateTask.revision_id == previous.id).with_for_update()):
        # Releasing the lease fences an in-flight aggregate commit on this revision.
        task.lease_token, task.lease_until, task.updated_at = None, 0, now
    return {"revision_id": previous.id, "waterline": waterline, "boundary": boundary,
            "at": now, "run_id": run_id}


def safe_pause(db, composite, target_revision_id, *, run_id, now):
    """Pause rules when no revision can serve them after a failed switch."""
    active = (db.get(CompositePreparation, composite.active_revision_id)
              if composite.active_revision_id else None)
    bound = len(composite_alerts.bound_rules(db, composite.id))
    if (active is not None and composite.active_revision_id != target_revision_id
            and not frozen(active)):
        return {"paused": [], "bound": bound, "reason": "旧修订继续运行"}
    paused = composite_alerts.pause_bound(db, composite.id, reason=FROZEN_REASON,
        run_id=run_id, now=now)
    return {"paused": paused["paused"], "bound": bound,
            "reason": "当前修订无法继续服务，已安全暂停"}


def reasons(stage, error):
    """One deduplicated reason per failing stage; source checks keep each cause."""
    report = getattr(error, "report", None)
    if isinstance(report, dict) and report.get("failures"):
        # Each incompatible capability is its own cause, never one merged blurb.
        return [{"stage": stage, "scope": failure["field"], "type": type(error).__name__,
                 "reason": failure["reason"]} for failure in report["failures"]]
    return [{"stage": stage, "scope": "switch", "type": type(error).__name__,
             "reason": str(error) or type(error).__name__}]


def recover(db, *, composite_id, previous_revision_id, target_revision_id, run_id, scheduled_for,
            stage, error, completed, source=None, now):
    """Discard the partial activation, then record it once and report it once."""
    failure = {"stage": stage, "type": type(error).__name__, "reason": str(error)[:500],
               "completed_stages": list(completed)}
    db.rollback()
    with transaction() as other:
        composite = other.get(MarketComposite, composite_id)
        # Same lock order as the publishing path: run row, then rule bindings.
        row = open_run(other, composite_id=composite_id,
            previous_revision_id=previous_revision_id, target_revision_id=target_revision_id,
            scheduled_for=scheduled_for, run_id=run_id)
        paused = (safe_pause(other, composite, target_revision_id, run_id=run_id, now=now)
                  if composite else {"paused": [], "bound": 0, "reason": "组合不存在"})
        # Only a run that reached the binding stage is partially applied.
        state = "partial" if "alerts" in completed or "fence" in completed else "failed"
        advance_to(row, state, now, phase=stage,
            error_summary={**failure, "paused_alerts": [item["id"] for item in paused["paused"]]})
        from .switch_runs import _record

        record = _record(row)
        other.flush()
        switch_notice.record(other, run=record, stage=stage, reasons=reasons(stage, error),
            counts={"sources": 2 if source and source["switch"] else 1,
                    "rules": paused["bound"],
                    "paused": len(paused["paused"]),
                    "active_revision_id": composite.active_revision_id},
            now=now)
        return {"run": record, "paused": paused, "failure": failure}


def publish(db, *, composite, revision, body, progress, now):
    """Publish the candidate as the running revision or leave nothing behind."""
    previous = db.get(CompositeRevision, composite.active_revision_id)
    if previous is None or previous.id == revision.id:
        raise ValueError("没有可切换的当前运行修订")
    run, source, stage, completed = None, None, "capability", []
    try:
        source = switch_source.check(db, previous, revision)
        stage = "run"
        run = open_run(db, composite_id=composite.id, previous_revision_id=previous.id,
            target_revision_id=revision.id, scheduled_for=now,
            run_id=getattr(body, "switch_run_id", None))
        advance_to(run, "shadow_ready", now, phase="capability")
        run.shadow_report = source
        advance_to(run, "activating", now, phase="binding")
        boundary = now // 60000 * 60000
        stage = "alerts"
        alerts = composite_alerts.rebind_active(db, composite, previous=previous,
            target=revision, boundary=boundary, run_id=run.id, now=now,
            input_revision=progress["input_revision"], source=source)
        completed.append("alerts")
        stage = "metrics"
        metrics = consolidate_metrics(db, revision, progress, run_id=run.id,
            boundary=boundary, now=now)
        completed.append("metrics")
        stage = "fence"
        fence = freeze_previous(db, previous, run_id=run.id, boundary=boundary, now=now)
        completed.append("fence")
        stage = "activation"
        activation = CompositeActivation(revision_id=revision.id,
            previous_revision_id=previous.id, request_id=body.request_id,
            input_revision=progress["input_revision"], event_boundary=boundary, at=now,
            evidence={"preparation": progress, "affected_rules": alerts["affected"],
                      "switch": {"run_id": run.id, "source": source, "alerts": alerts,
                                 "metrics": metrics, "fence": fence}})
        db.add(activation)
        composite.active_revision_id, revision.activated_at = revision.id, now
        db.flush()
        completed.append("activation")
        run.activation = {"revision_id": revision.id, "previous_revision_id": previous.id,
            "input_revision": progress["input_revision"], "event_boundary": boundary,
            "at": now, "run_id": run.id}
        advance_to(run, "succeeded", now, phase="activated")
        if alerts["paused"]:
            # A succeeded switch still owes one report when it could not move a rule.
            from .switch_runs import _record

            switch_notice.record(db, run=_record(run), stage="alerts",
                reasons=[{"stage": "alerts", "scope": item["id"], "type": "rule_not_relocatable",
                          "reason": item["reason"]} for item in alerts["affected"]
                         if item["migration"] == "paused_target_not_ready"],
                counts={"sources": 2 if source["switch"] else 1,
                        "rules": len(alerts["affected"]),
                        "paused": len(alerts["paused"]),
                        "active_revision_id": revision.id},
                now=now)
        return activation
    except Exception as error:
        recover(db, composite_id=composite.id, previous_revision_id=previous.id,
            target_revision_id=revision.id, run_id=run.id if run is not None else
            getattr(body, "switch_run_id", None), scheduled_for=now, stage=stage,
            error=error, completed=completed, source=source, now=now)
        raise
