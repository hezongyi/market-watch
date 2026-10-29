"""Weekly switch scheduling and the three bounded switch cycles.

The confirmed policy is one window per week: Sunday 01:00 UTC. The data profile
opens the window (one shadow report per composite the runtime already serves),
the market profile activates a candidate that is ready, and the cleanup pass
drains the 30-day window of a succeeded switch run. Nothing here re-implements
what it drives: ``baseline_shadow.shadow``, ``composite_revisions.activate``,
``switch_runs`` and ``retention_window.tick`` keep their own semantics, gates
and leases, so this module only decides when to call them and in what order.

Defaults (``alerts.config``):

* ``ALERTS_SWITCH_AUTO_ACTIVATE_ENABLED`` = ``true``: a candidate that the
  shadow report marks ready is activated by the market-runtime loop without a
  per-switch approval.
* ``ALERTS_RETENTION_MODE`` = ``dry_run``: ``off`` does nothing, ``dry_run``
  reports candidates and never deletes, ``execute`` deletes but still needs the
  restore-drill marker that ``retention_window`` enforces itself.

Activation is one-shot per candidate revision: a failure keeps its own recorded
failed/partial run and this loop never retries it automatically; only a new
Sunday window opens a new slot, and with it new runs.

Activation trusts the persisted shadow verdict, not the run state alone:
baseline_shadow marks the run shadow_ready and only then downgrades a not-ready
candidate to failed, so a report that is not ready is deferred as
shadow_not_ready. A deferred window consumes no activation attempt and keeps the
retry that baseline_shadow owns. The gate is that verdict (status, ready and
reasons); rules the report lists as will_pause do not block it, because pausing
them is the activation path's own safe state, not a preparation failure.

The shadow run and the activation run are two records, not one. They are linked
by (composite_id, target_revision_id) plus the activation request id
'auto:<shadow_run_id>', which is enough for the audit trail; open_run only
accepts a revision_activation run, so the shadow run id is never delegated.

All three cycles live inside the existing profiles, so they inherit the group
ownership lock, the boot identity and every per-role heartbeat.
"""

import logging

from sqlalchemy import select

from . import composite_aggregates, retention_window, switch_runs
from .config import settings
from .runtime_health import progress
from .storage import MarketComposite, MarketSwitchRun, now_ms, transaction

log = logging.getLogger(__name__)

DAY_MS = 24 * 3600 * 1000
HOUR_MS = 3600 * 1000
WEEK_MS = 7 * DAY_MS
SLOT_WEEKDAY = 6      # Sunday in datetime.weekday() numbering (Monday is 0).
SLOT_HOUR = 1         # 01:00 UTC, the confirmed weekly window.
EPOCH_WEEKDAY = 3     # 1970-01-01 was a Thursday.
# Outer poll intervals; the cycle bodies never sleep for a whole period.
SHADOW_IDLE_SECONDS = 60
ACTIVATION_IDLE_SECONDS = 5
RETENTION_IDLE_SECONDS = 60
WORK_SECONDS = .5
FAILURE_SECONDS = 2
# A run in these states has nothing left to prepare for this window.
DONE_STATES = ("shadow_ready", "activating", "succeeded")
# Deferral reason: the persisted shadow verdict does not allow activation yet.
NOT_READY = "shadow_not_ready"


def _instant(now):
    return now_ms() if now is None else int(now)


def due_weekly(now=None):
    """The most recent Sunday 01:00 UTC at or before ``now``, in milliseconds.

    One slot is due at a time: after a longer outage only this window opens, so
    a catch-up covers the week that was missed and never replays several.
    """
    stamp = _instant(now)
    day = stamp // DAY_MS
    back = ((day + EPOCH_WEEKDAY) % 7 - SLOT_WEEKDAY) % 7
    slot = (day - back) * DAY_MS + SLOT_HOUR * HOUR_MS
    return slot if slot <= stamp else slot - WEEK_MS


def next_weekly(now=None):
    """The next Sunday 01:00 UTC strictly after ``now``, in milliseconds."""
    return due_weekly(now) + WEEK_MS


def eligible():
    """Composites the runtime already serves: the managed-realtime revision scope."""
    with transaction() as db:
        return tuple(db.scalars(select(MarketComposite.id).where(
            MarketComposite.active_revision_id.in_(composite_aggregates.runtime_revisions()),
        ).order_by(MarketComposite.id)))


def _shadow_one(composite_id, *, scheduled_for, kind, prepare, adapter, budget):
    record = switch_runs.start(kind, composite_id=composite_id, scheduled_for=scheduled_for)
    if record["state"] in DONE_STATES:
        return {"composite_id": composite_id, "run_id": record["id"],
                "state": record["state"], "status": "skipped"}
    # The same run id is reused: baseline_shadow retries failed/partial in place
    # and resumes a preparing run, so one window owns exactly one run per composite.
    report = prepare(composite_id, run_id=record["id"], adapter=adapter, budget=budget)
    return {"composite_id": composite_id, "run_id": report["run"]["id"],
            "state": report["run"]["state"],
            "status": "ready" if report["ready"] else "not_ready",
            "reasons": [reason["code"] for reason in report["reasons"][:5]]}


def shadow_cycle(*, now=None, adapter=None, budget=None, composites=None, prepare=None):
    """Open the due window and prepare one candidate per eligible composite."""
    from . import baseline_shadow

    prepare = baseline_shadow.shadow if prepare is None else prepare
    budget = baseline_shadow.BUDGET if budget is None else budget
    scheduled_for = due_weekly(now)
    names = eligible() if composites is None else tuple(composites)
    results = []
    for composite_id in names:
        try:
            results.append(_shadow_one(composite_id, scheduled_for=scheduled_for,
                                       kind=baseline_shadow.KIND, prepare=prepare,
                                       adapter=adapter, budget=budget))
        except Exception as error:  # one composite never stops the others
            log.warning("Shadow cycle failed composite=%s error_type=%s",
                        composite_id, type(error).__name__)
            results.append({"composite_id": composite_id, "status": "error",
                            "error": type(error).__name__})
    return {"scheduled_for": scheduled_for,
            "worked": any(item["status"] != "skipped" for item in results),
            "composites": results}


def _verdict(report):
    """Why a persisted shadow report does not allow activation; None means ready."""
    if not isinstance(report, dict):
        return NOT_READY
    if report.get("ready") is not True or report.get("status") != "ready":
        return NOT_READY
    if report.get("reasons"):
        return NOT_READY
    return None


def _deferral(db, row, activation_kind):
    """Why this window must wait; None means activate it now.

    baseline_shadow records the report (preparing -> shadow_ready) and only then
    downgrades a not-ready run to failed, so the state alone can name a candidate
    that is not ready. The verdict is therefore read from the report, and a
    deferred window consumes no activation attempt: its run keeps the retry that
    baseline_shadow owns.
    """
    verdict = _verdict(row.shadow_report)
    if verdict:
        return verdict
    composite = db.get(MarketComposite, row.composite_id)
    if composite is None:
        return "composite_missing"
    if composite.active_revision_id == row.target_revision_id:
        return "already_active"
    # A window prepared against a revision that is no longer active is stale:
    # activate() would refuse it, so it waits for a new window.
    if composite.active_revision_id != row.previous_revision_id:
        return "window_superseded"
    # One activation attempt per candidate revision; a failed or partial attempt
    # is retried explicitly, never by this loop.
    if db.scalar(select(MarketSwitchRun.id).where(
            MarketSwitchRun.kind == activation_kind,
            MarketSwitchRun.composite_id == row.composite_id,
            MarketSwitchRun.target_revision_id == row.target_revision_id).limit(1)):
        return "activation_recorded"
    return None


def activation_targets():
    """Windows to activate now, plus every deferred window with its reason."""
    from .baseline_shadow import KIND as shadow_kind
    from .switch_activation import KIND as activation_kind

    with transaction() as db:
        rows = list(db.scalars(select(MarketSwitchRun).where(
            MarketSwitchRun.kind == shadow_kind,
            MarketSwitchRun.state == "shadow_ready",
            MarketSwitchRun.composite_id.is_not(None),
            MarketSwitchRun.previous_revision_id.is_not(None),
            MarketSwitchRun.target_revision_id.is_not(None),
        ).order_by(MarketSwitchRun.created_at, MarketSwitchRun.id)))
        pending, skipped = [], []
        for row in rows:
            window = {"run_id": row.id, "composite_id": row.composite_id,
                      "revision_id": row.target_revision_id,
                      "previous_revision_id": row.previous_revision_id,
                      "scheduled_for": row.scheduled_for}
            reason = _deferral(db, row, activation_kind)
            if reason:
                skipped.append({**window, "reason": reason})
            else:
                pending.append(window)
        return tuple(pending), tuple(skipped)


def activation_cycle(*, activate=None):
    """Activate every ready candidate once, through the existing activation path."""
    from .composite_revisions import activate as default_activate

    activate = default_activate if activate is None else activate
    candidates, skipped = activation_targets()
    results = []
    for item in candidates:
        try:
            with transaction() as db:
                activate(db, item["composite_id"], item["revision_id"], {
                    "request_id": "auto:" + item["run_id"],
                    "expected_revision_id": item["previous_revision_id"],
                })
            results.append({**item, "status": "activated"})
        except Exception as error:
            log.warning("Activation cycle failed composite=%s run=%s error_type=%s",
                        item["composite_id"], item["run_id"], type(error).__name__)
            results.append({**item, "status": "failed", "error": type(error).__name__})
    return {"worked": bool(results), "candidates": results, "skipped": list(skipped)}


def retention_cycle(*, mode=None, now=None, limit=None, chunk=None, budget_ms=None,
                    tick=None):
    """Run one bounded cleanup pass; only ``execute`` may delete anything.

    The 30-day window, the unlocked-run requirement and the restore-drill gate
    all stay inside ``retention_window``: this cycle only selects the mode.
    """
    mode = settings.retention_mode if mode is None else mode
    if mode == "off":
        return {"mode": mode, "worked": False, "unlocked": False,
                "reason": "retention_off", "runs": [], "report": None}
    run = retention_window.tick if tick is None else tick
    result = run(dry_run=mode != "execute",
                 limit=retention_window.DEFAULT_LIMIT if limit is None else limit,
                 chunk=retention_window.DEFAULT_CHUNK if chunk is None else chunk,
                 budget_ms=(retention_window.DEFAULT_BUDGET_MS
                            if budget_ms is None else budget_ms),
                 now=now)
    return {"mode": mode, "worked": bool(result.get("unlocked")), **result}


def _failure(items):
    return next((item["error"] for item in items if item.get("error")), None)


def run_shadow(stop, *, adapter=None, budget=None, idle_wait=SHADOW_IDLE_SECONDS, cycle=None):
    """Poll the weekly window; a failing composite never stops the loop."""
    from .history_sources import HistorySources

    work = shadow_cycle if cycle is None else cycle
    source = HistorySources() if adapter is None else adapter
    try:
        while not stop.is_set():
            try:
                result = work(adapter=source, budget=budget)
                error, worked = _failure(result["composites"]), result["worked"]
            except Exception as failure:
                # One bounded local retry; the group fails only if the loop dies.
                log.error("Switch shadow cycle failed: %s", type(failure).__name__)
                progress(state="degraded", error=failure)
                stop.wait(FAILURE_SECONDS)
                continue
            progress(state="degraded" if error else "running" if worked else "idle",
                     error=error)
            stop.wait(WORK_SECONDS if worked else idle_wait)
    finally:
        if adapter is None:
            source.close()


def run_activation(stop, *, idle_wait=ACTIVATION_IDLE_SECONDS, cycle=None):
    """Poll for a ready candidate; activation itself keeps its own fencing."""
    work = activation_cycle if cycle is None else cycle
    while not stop.is_set():
        try:
            result = work()
            error, worked = _failure(result["candidates"]), result["worked"]
        except Exception as failure:
            log.error("Switch activation cycle failed: %s", type(failure).__name__)
            progress(state="degraded", error=failure)
            stop.wait(FAILURE_SECONDS)
            continue
        progress(state="degraded" if error else "running" if worked else "idle", error=error)
        stop.wait(WORK_SECONDS if worked else idle_wait)


def run_retention(stop, *, mode=None, idle_wait=RETENTION_IDLE_SECONDS, cycle=None):
    """Poll the cleanup window; the data profile's ownership lock already fences it."""
    work = retention_cycle if cycle is None else cycle
    while not stop.is_set():
        try:
            result = work(mode=mode)
            worked = result["worked"]
        except Exception as failure:
            log.error("Retention cycle failed: %s", type(failure).__name__)
            progress(state="degraded", error=failure)
            stop.wait(FAILURE_SECONDS)
            continue
        progress(state="running" if worked else "idle")
        stop.wait(WORK_SECONDS if worked else idle_wait)
