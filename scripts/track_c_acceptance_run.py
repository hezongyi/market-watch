"""Track C acceptance gates, driven through the application's own entry points.

Every step prints one JSON document; the shell redirects it into the artifact
directory. Nothing here re-implements a gate: the shadow, the activation, the
fencing checks and the cleanup all run their real modules.
"""

import argparse
import json
import sys
import threading
import time

from alerts import baseline_shadow, composite_aggregates, composite_preparation
from alerts import composite_revisions, retention_window, switch_activation
from alerts import switch_runs, switch_schedule, storage
from alerts.chart_alert_worker import evaluate as evaluate_alert
from alerts.chart_data import FRAMES
from alerts.config import settings
from alerts.market_contracts import CandleBatch, DatasetIdentity, RequestResult
from alerts.storage import (
    ChartAlert,
    ChartAlertVersion,
    ChartPublication,
    CompositeActivation,
    CompositeAggregateBar,
    CompositeAggregateTask,
    CompositeInputEvent,
    CompositeJudgment,
    CompositeMinute,
    CompositeMinuteInput,
    CompositePreparation,
    CompositeRevision,
    MarketComposite,
    MarketDataset,
    MarketSwitchRun,
    Notification,
    Outbox,
    Preference,
    RealtimeMapping,
    SourceMinute,
    SourceMinuteRevision,
    transaction,
    now_ms,
)
from sqlalchemy import func, select

import track_c_acceptance_seed as fixtures

MIN = 60_000
DAY = 24 * 60 * MIN
HOUR = 60 * MIN
TABLES = ("market_source_minutes", "market_source_minute_revisions",
          "market_composite_minutes", "market_composite_minute_inputs",
          "market_composite_input_events")


def state():
    saved = fixtures.state()
    if not saved:
        raise SystemExit("database is not seeded; run track_c_acceptance_seed.py first")
    return saved


def run_row(run_id):
    return switch_runs.get(run_id)


def table_counts():
    with transaction() as db:
        lower = retention_window.lower_bound()
        out = {}
        for name, model in (("market_source_minutes", SourceMinute),
                            ("market_source_minute_revisions", SourceMinuteRevision),
                            ("market_composite_minutes", CompositeMinute),
                            ("market_composite_minute_inputs", CompositeMinuteInput),
                            ("market_composite_input_events", CompositeInputEvent)):
            out[name] = int(db.scalar(select(func.count()).select_from(model)) or 0)
            column = getattr(model, "start", None)
            if column is not None:
                out[name + "@old"] = int(db.scalar(select(func.count()).select_from(model)
                                                   .where(column < lower)) or 0)
        out["lower_bound"] = lower
        return out


def recent_counts():
    from alerts.storage import Bar, HistoryArtifact, HistoryChunk
    with transaction() as db:
        lower = retention_window.lower_bound()
        return {
            "source_minutes_inside_window": int(db.scalar(select(func.count()).select_from(
                SourceMinute).where(SourceMinute.start >= lower)) or 0),
            "bars": int(db.scalar(select(func.count()).select_from(Bar)) or 0),
            "history_chunks": int(db.scalar(select(func.count()).select_from(HistoryChunk)) or 0),
            "history_artifacts": int(db.scalar(select(func.count()).select_from(
                HistoryArtifact)) or 0),
        }


def fresh_slot(composite_id, weeks=0):
    """The first weekly window with no shadow run yet for this composite."""
    with transaction() as db:
        used = set(db.scalars(select(MarketSwitchRun.scheduled_for).where(
            MarketSwitchRun.kind == baseline_shadow.KIND,
            MarketSwitchRun.composite_id == composite_id)))
    slot = switch_schedule.next_weekly() + weeks * 7 * DAY
    while slot in used:
        slot += 7 * DAY
    return slot


def g1_shadow(slot=None):
    saved = state()
    composite = saved["a"]["composite"]
    slot = fresh_slot(composite) if slot is None else slot
    before = baseline_shadow.bindings(composite)
    cycle = switch_schedule.shadow_cycle(
        now=slot, composites=[composite],
        adapter=fixtures.AcceptanceAdapter(saved["clock"]), budget=4000)
    after = baseline_shadow.bindings(composite)
    item = cycle["composites"][0]
    record = run_row(item["run_id"])
    report = record.get("shadow_report") or {}
    with transaction() as db:
        active = db.get(MarketComposite, composite).active_revision_id
        candidate = db.get(CompositeRevision, record["target_revision_id"])
        candidate_version = db.get(__import__("alerts.storage", fromlist=["HistoryVersion"])
                                   .HistoryVersion, candidate.history_version_id)
        active_version = db.get(__import__("alerts.storage", fromlist=["HistoryVersion"])
                                .HistoryVersion, db.get(CompositeRevision, active).history_version_id)
    return {
        "cycle": cycle,
        "window": {"requested_slot": slot, "scheduled_for": record["scheduled_for"]},
        "run": {"id": record["id"], "kind": record["kind"], "state": record["state"],
                "previous_revision_id": record["previous_revision_id"],
                "target_revision_id": record["target_revision_id"],
                "scheduled_for": record["scheduled_for"]},
        "candidate_differs_from_active": record["target_revision_id"] != active,
        "history": {"active_version": active_version.id, "candidate_version": candidate_version.id,
                    "active_end": active_version.end, "candidate_end": candidate_version.end,
                    "same_dataset": active_version.dataset_id == candidate_version.dataset_id},
        "bindings": baseline_shadow.binding_report(before, after),
        "report": {key: report.get(key) for key in (
            "schema", "status", "ready", "reasons", "run", "history_version", "revision",
            "preparation")},
        "bars": report.get("bars"),
        "indicators": report.get("indicators"),
        "gaps": report.get("gaps"),
        "paused_rules": report.get("paused_rules"),
        "preparation": report.get("preparation"),
    }


def g2_activation(run_id=None):
    saved = state()
    composite = saved["a"]["composite"]
    with transaction() as db:
        shadow = db.scalar(select(MarketSwitchRun).where(
            MarketSwitchRun.kind == baseline_shadow.KIND,
            MarketSwitchRun.composite_id == composite,
            MarketSwitchRun.id == run_id if run_id else True).order_by(
                MarketSwitchRun.created_at.desc()).limit(1))
        shadow_id, target, previous = shadow.id, shadow.target_revision_id, shadow.previous_revision_id
    before = evaluate_alert_counts()
    cycle = switch_schedule.activation_cycle()
    after = evaluate_alert_counts()
    with transaction() as db:
        runs = list(db.scalars(select(MarketSwitchRun).where(
            MarketSwitchRun.composite_id == composite).order_by(MarketSwitchRun.created_at)))
        activation_run = next((row for row in runs if row.kind == switch_activation.KIND
                               and row.target_revision_id == target), None)
        activation = db.get(CompositeActivation, target)
        previous_prep = db.get(CompositePreparation, previous)
        candidate_prep = db.get(CompositePreparation, target)
        alerts = list(db.scalars(select(ChartAlert).where(ChartAlert.status != "archived")))
        versions = [{"alert_id": row.alert_id, "version": row.version,
                     "revision_id": (row.market_identity or {}).get("composite_revision_id"),
                     "condition": (row.config or {}).get("condition"),
                     "geometry": (row.config or {}).get("seam_policy"),
                     "composite_revision_id": (row.config or {}).get("composite_revision_id")}
                    for row in db.scalars(select(ChartAlertVersion).order_by(
                        ChartAlertVersion.alert_id, ChartAlertVersion.version))]
        result = {
            "activation_cycle": cycle,
            "shadow_run": {"id": shadow_id, "previous_revision_id": previous,
                           "target_revision_id": target, "state": run_row(shadow_id)["state"]},
            "run": None if activation_run is None else {
                "id": activation_run.id, "state": activation_run.state,
                "phase": activation_run.phase, "attempts": activation_run.attempts,
                "activation": activation_run.activation,
                "error_summary": activation_run.error_summary},
            "active_revision_id": db.get(MarketComposite, composite).active_revision_id,
            "activation": None if activation is None else {
                "revision_id": activation.revision_id,
                "previous_revision_id": activation.previous_revision_id,
                "event_boundary": activation.event_boundary,
                "input_revision": activation.input_revision,
                "evidence": (activation.evidence or {}).get("switch")},
            "previous_frozen": bool((previous_prep.state or {}).get("revision_frozen")),
            "previous_fence": (previous_prep.state or {}).get("fence"),
            "previous_waterline": previous_prep.input_revision,
            "candidate_waterline": candidate_prep.input_revision,
            "alert_rows": [{"id": row.id, "version": row.version, "status": row.status,
                            "state": row.state, "effective_at": row.effective_at,
                            "control_revision": row.control_revision,
                            "health": row.health, "health_reason": row.health_reason,
                            "runtime": row.runtime} for row in alerts],
            "alert_versions": versions,
            "unlocked_runs": [item for item in switch_runs.unlocked_runs(limit=50)],
            "judgments": {"before": before, "after": after},
        }
    return result


def evaluate_alert_counts():
    with transaction() as db:
        return {"judgments": int(db.scalar(select(func.count()).select_from(
            CompositeJudgment)) or 0),
            "notifications": int(db.scalar(select(func.count()).select_from(Notification)) or 0),
            "outbox": int(db.scalar(select(func.count()).select_from(Outbox)) or 0)}


def g2_fencing(run_id=None):
    """Late writes for the superseded revision must be refused, not applied."""
    saved = state()
    with transaction() as db:
        activation = db.scalar(select(CompositeActivation).join(
            MarketSwitchRun, MarketSwitchRun.target_revision_id == CompositeActivation.revision_id
        ).where(MarketSwitchRun.composite_id == saved["a"]["composite"]).order_by(
            CompositeActivation.at.desc()).limit(1))
        old, boundary = activation.previous_revision_id, activation.event_boundary
        prep = db.get(CompositePreparation, old)
        waterline, confirmed_end = prep.input_revision, prep.confirmed_end
        revision = db.get(CompositeRevision, old)
        target = db.get(MarketDataset, db.get(RealtimeMapping, revision.mapping_id).target_dataset_id)
        identity = DatasetIdentity.model_validate(target.identity)
        bars_before = int(db.scalar(select(func.count()).select_from(CompositeAggregateBar)) or 0)
        late_start = confirmed_end + 5 * MIN
    from alerts.composite_inputs import apply_minutes
    from alerts.confirmed_minutes import record
    batch = CandleBatch(identity=identity, window_start=late_start, window_end=late_start + MIN,
                        observed_at=now_ms(), checkpoint=late_start + MIN,
                        result=RequestResult(status="data"),
                        rows=fixtures.rows_for(late_start, late_start + MIN, dense_end=saved["clock"]),
                        volume_kind="price_count", volume_unit="quotes")
    with transaction() as db:
        applied = apply_minutes(db, record(db, batch))
    claimed = composite_aggregates.claim(old, "M1")
    ticked = composite_aggregates.aggregate_tick(old, "M1")
    with transaction() as db:
        prep = db.get(CompositePreparation, old)
        bars_after = int(db.scalar(select(func.count()).select_from(CompositeAggregateBar)) or 0)
        return {
            "old_revision_id": old,
            "event_boundary": boundary,
            "late_minute": late_start,
            "applied_to_old": [item for item in applied if item["revision_id"] == old],
            "applied_any": applied,
            "aggregate_claim_after_freeze": claimed,
            "aggregate_tick_after_freeze": ticked,
            "revision_still_frozen": bool((prep.state or {}).get("revision_frozen")),
            "waterline_before": waterline,
            "waterline_after": prep.input_revision,
            "waterline_unchanged": prep.input_revision == waterline,
            "bars_before": bars_before,
            "bars_after": bars_after,
        }


REPORT_KEY = "track_c_acceptance:report"


def head_note():
    """Which HEAD produced an artifact (the image has no git binary)."""
    import os
    import subprocess

    sha = os.environ.get("MW_TC_HEAD", "").strip()
    if sha:
        return {"head": sha, "source": "env MW_TC_HEAD"}
    try:
        sha = subprocess.run(["git", "-C", "/candidate", "rev-parse", "HEAD"],
                             capture_output=True, text=True, timeout=20).stdout.strip()
        return {"head": sha, "source": "git"}
    except Exception as error:  # noqa: BLE001 - recorded, never guessed
        return {"head": "unknown", "source": type(error).__name__}


def add_pause_rule():
    """A rule the shadow must mark will_pause although relocatable() would move it."""
    from alerts.chart_alert_service import AlertConfig, create as create_alert

    saved = state()
    with transaction() as db:
        active = db.get(MarketComposite, saved["a"]["composite"]).active_revision_id
        revision = db.get(CompositeRevision, active)
        bound_start = db.get(__import__("alerts.storage", fromlist=["HistoryVersion"])
                             .HistoryVersion, revision.history_version_id).start
    # The rule validates against its bound history start; a candidate version that
    # starts later is then what the shadow reports as not relocatable.
    origin = bound_start
    fixtures.live_source(active, saved["clock"])
    config = AlertConfig.model_validate({
        "name": "计算起点晚于候选历史（shadow 判不可迁移）",
        "instrument": saved["a"]["composite"], "series_kind": "composite",
        "source": "composite", "timeframe": "M1", "max_triggers": 3,
        "composite_revision_id": active, "calculation_origin": origin,
        "condition": {"relation": "cross_up", "left": {"kind": "price"},
                      "right": {"kind": "constant", "value": "1.1030"}},
    })
    with transaction() as db:
        alert = create_alert(db, "acceptance-shadow-pause-rule", config, at=saved["clock"])
        return {"alert_id": alert.id, "calculation_origin": origin,
                "bound_revision_id": active, "head": head_note()["head"]}


def seed_orphan_minutes(minutes=120, days_back=33):
    """Old confirmed minutes no composite references: real cleanup candidates."""
    from alerts.confirmed_minutes import record
    from alerts.market_contracts import MinuteRow

    saved = state()
    ident = DatasetIdentity(source="oanda", channel="v20", environment="practice",
                            account_scope="public", provider_symbol="EUR_USD", basis="bid",
                            calendar_version="candidate-ny17-v1")
    stop = int((saved["clock"] - int(days_back) * DAY) // MIN * MIN)
    start = stop - minutes * MIN
    rows = tuple(MinuteRow(timestamp=start + index * MIN,
                           open=f"{1.1 + index * 1e-6:.5f}",
                           high=f"{1.1 + index * 1e-6 + 4e-4:.5f}",
                           low=f"{1.1 + index * 1e-6 - 4e-4:.5f}",
                           close=f"{1.1 + index * 1e-6 + 2e-4:.5f}",
                           volume="3.0", complete=True)
                for index in range(minutes))
    batch = CandleBatch(identity=ident, window_start=start, window_end=stop,
                        observed_at=saved["clock"], checkpoint=stop,
                        result=RequestResult(status="data"), rows=rows,
                        volume_kind="price_count", volume_unit="quotes")
    with transaction() as db:
        recorded = record(db, batch)
    return {"source_series": ident.key, "window": [start, stop], "minutes": len(recorded),
            "lower_bound": retention_window.lower_bound()}


def activation_snapshot():
    """What the Sunday loop would activate now, and why the rest waits."""
    pending, skipped = switch_schedule.activation_targets()
    return {"pending": list(pending), "skipped": list(skipped), "head": head_note()["head"]}


def set_report_state(run_id, mode="not_ready"):
    """Controlled stimulus for the shadow-verdict gate; the same step restores it."""
    with transaction() as db:
        row = db.get(MarketSwitchRun, run_id)
        preference = db.get(Preference, REPORT_KEY)
        if mode == "not_ready":
            original = {"state": row.state, "report": row.shadow_report}
            if preference is None:
                db.add(Preference(key=REPORT_KEY, value=original))
            else:
                preference.value = original
            report = dict(row.shadow_report or {})
            report.update({"status": "not_ready", "ready": False,
                           "reasons": [{"code": "preparation_not_ready",
                                       "detail": "acceptance stimulus: report not_ready"}]})
            row.shadow_report = report
            row.state = "shadow_ready"
            return {"stimulus": "not_ready", "run_id": run_id, "state": row.state,
                    "original_state": original["state"]}
        if preference is None:
            raise SystemExit("nothing to restore")
        original = dict(preference.value)
        row.state, row.shadow_report = original["state"], original["report"]
        db.delete(preference)
        return {"restored": "report", "run_id": run_id, "state": row.state,
                "report_status": (row.shadow_report or {}).get("status")}

def g2_pause_branch():
    """Composite B: a calendar change must pause the rule with a concrete reason."""
    saved = state()
    built = fixtures.build_utc_candidate()
    with transaction() as db:
        composite = db.get(MarketComposite, saved["b"]["composite"])
        previous = composite.active_revision_id
        rule = db.get(ChartAlert, saved["b"]["alert"])
        before = {"alert_version": rule.version, "status": rule.status,
                  "versions": [{"version": row.version,
                                "revision_id": (row.market_identity or {}).get(
                                    "composite_revision_id")}
                               for row in db.scalars(select(ChartAlertVersion).where(
                                   ChartAlertVersion.alert_id == rule.id).order_by(
                                       ChartAlertVersion.version))]}
    error = None
    try:
        with transaction() as db:
            composite_revisions.activate(db, saved["b"]["composite"], built["revision"], {
                "request_id": "acceptance-calendar-change",
                "expected_revision_id": previous})
    except Exception as failure:  # noqa: BLE001 - the run must report the gate itself
        error = {"type": type(failure).__name__, "detail": str(failure)}
    with transaction() as db:
        rule = db.get(ChartAlert, saved["b"]["alert"])
        run = db.scalar(select(MarketSwitchRun).where(
            MarketSwitchRun.kind == switch_activation.KIND,
            MarketSwitchRun.composite_id == saved["b"]["composite"],
            MarketSwitchRun.target_revision_id == built["revision"]))
        composite = db.get(MarketComposite, saved["b"]["composite"])
        return {
            "candidate": built,
            "error": error,
            "run": None if run is None else {"id": run.id, "state": run.state, "phase": run.phase,
                                             "attempts": run.attempts,
                                             "error_summary": run.error_summary},
            "active_revision_id": composite.active_revision_id,
            "rule": {"status": rule.status, "health": rule.health,
                     "health_reason": rule.health_reason, "version": rule.version,
                     "runtime": rule.runtime, "before": before},
            "versions": [{"version": row.version,
                          "revision_id": (row.market_identity or {}).get("composite_revision_id")}
                         for row in db.scalars(select(ChartAlertVersion).where(
                             ChartAlertVersion.alert_id == rule.id).order_by(
                                 ChartAlertVersion.version))],
        }


def g3_feed():
    """New confirmed minutes while the API is down: input, aggregates, checkpoint."""
    saved = state()
    with transaction() as db:
        composite = db.get(MarketComposite, saved["a"]["composite"])
        revision = db.get(CompositeRevision, composite.active_revision_id)
        prep = db.get(CompositePreparation, revision.id)
        target = db.get(MarketDataset, db.get(RealtimeMapping, revision.mapping_id).target_dataset_id)
        identity = DatasetIdentity.model_validate(target.identity)
        start, stop = prep.confirmed_end, prep.confirmed_end + 4 * HOUR
    from alerts.composite_inputs import apply_minutes
    from alerts.confirmed_minutes import record
    before = watermarks(saved["a"]["composite"])
    batch = CandleBatch(identity=identity, window_start=start, window_end=stop,
                        observed_at=now_ms(), checkpoint=stop,
                        result=RequestResult(status="data"),
                        rows=fixtures.rows_for(start, stop, dense_end=saved["clock"]),
                        volume_kind="price_count", volume_unit="quotes")
    with transaction() as db:
        applied = apply_minutes(db, record(db, batch))
    waited = 0
    after = before
    for _ in range(120):
        after = watermarks(saved["a"]["composite"])
        if after["confirmed_end"] > before["confirmed_end"] and all(
                task["applied"] >= after["input_revision"] for task in after["tasks"].values()):
            break
        time.sleep(2)
        waited += 2
    with transaction() as db:
        revision = db.get(CompositeRevision, db.get(MarketComposite,
                                                    saved["a"]["composite"]).active_revision_id)
        stamp = db.get(CompositePreparation, revision.id).confirmed_end
    fixtures.live_source(revision.id, stamp)
    judged = fixtures.judge(saved["a"]["alert"], stamp)
    return {"minutes_recorded": len(batch.rows), "window": [start, stop],
            "applied_events": len(applied), "before": before, "after": after,
            "waited_seconds": waited, "judge_after_feed": judged}


def watermarks(composite_id):
    with transaction() as db:
        composite = db.get(MarketComposite, composite_id)
        revision = db.get(CompositeRevision, composite.active_revision_id)
        prep = db.get(CompositePreparation, revision.id)
        tasks = {task.timeframe: {"applied": task.applied_input_revision, "offset": task.offset,
                                  "error": task.error} for task in db.scalars(
            select(CompositeAggregateTask).where(
                CompositeAggregateTask.revision_id == revision.id))}
        return {"revision_id": revision.id, "input_revision": prep.input_revision,
                "confirmed_end": prep.confirmed_end, "status": prep.status,
                "tasks": tasks,
                "judgments": int(db.scalar(select(func.count()).select_from(
                    CompositeJudgment)) or 0)}


def _run_id_for(conn, composite_id, slot):
    from sqlalchemy import text

    row = conn.execute(text(
        "select id from market_switch_runs where kind = 'baseline_shadow'"
        " and composite_id = :composite and scheduled_for = :slot"),
        {"composite": composite_id, "slot": slot}).first()
    return row[0] if row else None


def _apply_binding_change(revision_alert_ids, instruments):
    """Change rows that belong to this composite, from an independent connection."""
    from sqlalchemy import create_engine, text
    from sqlalchemy.orm import sessionmaker

    engine = create_engine(settings.database_url)
    try:
        factory = sessionmaker(engine)
        with factory.begin() as db:
            version = db.execute(text(
                "select id, alert_id, version, effective_at from chart_alert_versions"
                " where alert_id = :alert order by version desc limit 1"),
                {"alert": revision_alert_ids[0]}).one()
            publication = None
            for instrument in instruments:
                publication = db.execute(text(
                    'select instrument_id, timeframe, start, "end", complete_count, revision,'
                    " initialized, updated_at from chart_publications"
                    " where instrument_id = :instrument and timeframe = 'M1'"),
                    {"instrument": instrument}).first()
                if publication is not None:
                    break
            if publication is None:
                raise RuntimeError("no in-scope publication row to change")
            original = {
                "publication": {"instrument_id": publication[0], "timeframe": publication[1],
                                "start": publication[2], "end": publication[3],
                                "complete_count": publication[4], "revision": publication[5],
                                "initialized": publication[6], "updated_at": publication[7]},
                "alert_version": {"id": version[0], "alert_id": version[1],
                                  "version": version[2], "effective_at": version[3]},
            }
            db.execute(text(
                "insert into preferences(key, value) values (:key, cast(:value as json))"
                " on conflict (key) do update set value = excluded.value"),
                {"key": TAMPER_KEY, "value": json.dumps(original)})
            db.execute(text("update chart_alert_versions set effective_at = :value where id = :id"),
                       {"value": original["alert_version"]["effective_at"] + 1,
                        "id": original["alert_version"]["id"]})
            db.execute(text(
                "update chart_publications set complete_count = :count, updated_at = :updated"
                " where instrument_id = :instrument and timeframe = 'M1'"),
                {"count": original["publication"]["complete_count"] + 1,
                 "updated": original["publication"]["updated_at"] + 1000,
                 "instrument": original["publication"]["instrument_id"]})
        return {"applied": True, "original": original}
    finally:
        engine.dispose()


UNRELATED_KEY = "track_c_acceptance:unrelated"
UNRELATED_INSTRUMENT = "BTCUSDT"


def _apply_unrelated_change():
    """Move another instrument's publication row while this shadow runs."""
    from sqlalchemy import create_engine, text
    from sqlalchemy.orm import sessionmaker

    engine = create_engine(settings.database_url)
    try:
        factory = sessionmaker(engine)
        with factory.begin() as db:
            row = db.execute(text(
                'select instrument_id, timeframe, complete_count, revision, updated_at'
                " from chart_publications where instrument_id = :i and timeframe = 'M1'"),
                {"i": UNRELATED_INSTRUMENT}).one()
            original = {"instrument_id": row[0], "timeframe": row[1], "complete_count": row[2],
                        "revision": row[3], "updated_at": row[4]}
            db.execute(text(
                "insert into preferences(key, value) values (:key, cast(:value as json))"
                " on conflict (key) do update set value = excluded.value"),
                {"key": UNRELATED_KEY, "value": json.dumps(original)})
            db.execute(text(
                "update chart_publications set revision = :revision, updated_at = :updated"
                " where instrument_id = :i and timeframe = 'M1'"),
                {"revision": original["revision"] + 1, "updated": original["updated_at"] + 1000,
                 "i": UNRELATED_INSTRUMENT})
        return {"applied": True, "original": original,
                "note": "another instrument published while this shadow ran"}
    finally:
        engine.dispose()


def restore_unrelated():
    from sqlalchemy import text

    with transaction() as db:
        preference = db.get(Preference, UNRELATED_KEY)
        if preference is None:
            raise SystemExit("nothing to restore")
        original = dict(preference.value)
        row = db.get(ChartPublication, (original["instrument_id"], original["timeframe"]))
        row.complete_count, row.revision, row.updated_at = (
            original["complete_count"], original["revision"], original["updated_at"])
        db.delete(preference)
    return {"restored": original}


def g1_shadow_with_tamper(version_key="v7", days=29, slot=None, target="scope"):
    """The same shadow, but this composite's own bindings move while it runs.

    The reverse proof for the narrowed snapshot: an unrelated symbol publishing
    must not fail the run, a change inside this composite's own scope must.
    """
    from sqlalchemy import create_engine, text

    saved = state()
    composite = saved["a"]["composite"]
    bounds = baseline_shadow.bindings(composite)["scope"]
    slot = fresh_slot(composite) if slot is None else slot
    engine = create_engine(settings.database_url)
    outcome = {}

    def tamper():
        deadline = time.time() + 180
        while time.time() < deadline:
            try:
                with engine.connect() as conn:
                    found = _run_id_for(conn, composite, slot)
            except Exception as error:  # noqa: BLE001 - reported, never silently swallowed
                outcome["poll_error"] = type(error).__name__ + ": " + str(error)
                found = None
            if found:
                outcome["run_id_seen"] = found
                apply = (_apply_binding_change if target == "scope"
                         else lambda *_: _apply_unrelated_change())
                outcome["tamper"] = apply(bounds["alert_ids"], bounds["instruments"])
                outcome["target"] = target
                outcome["tampered_at"] = now_ms()
                return
            time.sleep(0.1)
        outcome["timeout"] = True

    thread = threading.Thread(target=tamper, daemon=True)
    published = fixtures.publish_forward(days, version_key) if days and days > 0 else None
    before = baseline_shadow.bindings(composite)
    thread.start()
    cycle = switch_schedule.shadow_cycle(now=slot, composites=[composite],
                                         adapter=fixtures.AcceptanceAdapter(saved["clock"]),
                                         budget=4000)
    thread.join(240)
    after = baseline_shadow.bindings(composite)
    item = cycle["composites"][0]
    record = run_row(item["run_id"])
    report = record.get("shadow_report") or {}
    return {"published_version": published,
            "window": {"requested_slot": slot, "scheduled_for": record["scheduled_for"]},
            "cycle": cycle,
            "run": {"id": record["id"], "state": record["state"], "phase": record["phase"],
                    "scheduled_for": record["scheduled_for"],
                    "target_revision_id": record["target_revision_id"],
                    "error_summary": record["error_summary"]},
            "tamper_outcome": outcome,
            "status": report.get("status"), "ready": report.get("ready"),
            "reasons": report.get("reasons"),
            "bindings": baseline_shadow.binding_report(before, after),
            "preparation": report.get("preparation"),
            "revert": "python /candidate/scripts/track_c_acceptance_run.py restore-scope"}


def g3_shadow(version_key="v3", days=12, slot=None):
    """One shadow for the next weekly window; the API stays down throughout."""
    saved = state()
    # days <= 0 reuses the newest published version instead of publishing one.
    published = fixtures.publish_forward(days, version_key) if days and days > 0 else None
    composite = saved["a"]["composite"]
    slot = fresh_slot(composite) if slot is None else slot
    before = baseline_shadow.bindings(composite)
    cycle = switch_schedule.shadow_cycle(now=slot, composites=[composite],
                                         adapter=fixtures.AcceptanceAdapter(saved["clock"]),
                                         budget=4000)
    after = baseline_shadow.bindings(composite)
    item = cycle["composites"][0]
    record = run_row(item["run_id"])
    report = record.get("shadow_report") or {}
    return {"published_version": published,
            "window": {"requested_slot": slot, "scheduled_for": record["scheduled_for"]},
            "cycle": cycle,
            "run": {"id": record["id"], "state": record["state"],
                    "phase": record["phase"],
                    "scheduled_for": record["scheduled_for"],
                    "target_revision_id": record["target_revision_id"]},
            "status": report.get("status"), "ready": report.get("ready"),
            "reasons": report.get("reasons"),
            "bindings": baseline_shadow.binding_report(before, after),
            "preparation": report.get("preparation")}


def run_report(run_id):
    record = run_row(run_id)
    report = record.get("shadow_report") or {}
    return {"run": {key: record[key] for key in (
        "id", "kind", "state", "phase", "attempts", "composite_id", "previous_revision_id",
        "target_revision_id", "scheduled_for", "started_at", "finished_at", "error_summary")},
        "report": {key: report.get(key) for key in (
            "schema", "status", "ready", "reasons", "bindings", "preparation", "run",
            "history_version", "revision")}}


TAMPER_KEY = "track_c_acceptance:tamper"


def tamper_scope():
    """Reverse proof: move one in-scope publication row and one in-scope alert version.

    Both rows belong to this composite, so the narrowed snapshot must still fail.
    The originals are stored in a preference and put back by restore_scope().
    """
    from alerts.storage import ChartAlert, Preference
    from sqlalchemy import text

    saved = state()
    with transaction() as db:
        composite = db.get(MarketComposite, saved["a"]["composite"])
        bounds = baseline_shadow.bindings(saved["a"]["composite"])["scope"]
        publication = next((db.get(ChartPublication, (instrument, "M1"))
                            for instrument in bounds["instruments"]
                            if db.get(ChartPublication, (instrument, "M1")) is not None), None)
        alert = db.get(ChartAlert, bounds["alert_ids"][0])
        version = db.scalar(select(ChartAlertVersion).where(
            ChartAlertVersion.alert_id == alert.id,
            ChartAlertVersion.version == alert.version))
        original = {
            "publication": {"instrument_id": publication.instrument_id,
                            "timeframe": publication.timeframe, "start": publication.start,
                            "end": publication.end, "complete_count": publication.complete_count,
                            "revision": publication.revision,
                            "initialized": publication.initialized,
                            "updated_at": publication.updated_at},
            "alert_version": {"id": version.id, "alert_id": version.alert_id,
                              "version": version.version, "effective_at": version.effective_at},
        }
        preference = db.get(Preference, TAMPER_KEY)
        if preference is None:
            db.add(Preference(key=TAMPER_KEY, value=original))
        else:
            preference.value = original
        publication.complete_count = original["publication"]["complete_count"] + 1
        publication.updated_at = original["publication"]["updated_at"] + 1000
        # The alert version table is immutable through the ORM, so the deliberate
        # proof write and its revert are explicit SQL on this acceptance database.
        db.execute(text("UPDATE chart_alert_versions SET effective_at = :value WHERE id = :id"),
                   {"value": original["alert_version"]["effective_at"] + 1,
                    "id": original["alert_version"]["id"]})
        tampered = {
            "publication": {"instrument_id": publication.instrument_id,
                            "complete_count": publication.complete_count,
                            "updated_at": publication.updated_at},
            "alert_version": {"id": original["alert_version"]["id"],
                              "effective_at": original["alert_version"]["effective_at"] + 1},
        }
    return {"scope": bounds, "original": original, "tampered": tampered,
            "revert": "python /candidate/scripts/track_c_acceptance_run.py restore-scope"}


def restore_scope():
    from alerts.storage import Preference
    from sqlalchemy import text

    with transaction() as db:
        preference = db.get(Preference, TAMPER_KEY)
        if preference is None:
            raise SystemExit("nothing to restore")
        original = dict(preference.value)
        published = original["publication"]
        row = db.get(ChartPublication, (published["instrument_id"], published["timeframe"]))
        row.start, row.end = published["start"], published["end"]
        row.complete_count, row.revision = published["complete_count"], published["revision"]
        row.initialized, row.updated_at = published["initialized"], published["updated_at"]
        db.execute(text("UPDATE chart_alert_versions SET effective_at = :value WHERE id = :id"),
                   {"value": original["alert_version"]["effective_at"],
                    "id": original["alert_version"]["id"]})
        restored = {"publication": {"instrument_id": row.instrument_id,
                                    "complete_count": row.complete_count,
                                    "updated_at": row.updated_at},
                    "alert_version": {"id": original["alert_version"]["id"],
                                      "effective_at": original["alert_version"]["effective_at"]}}
        db.delete(preference)
    return {"restored": restored, "original": original}


def _rule_snapshot(db, composite_id):
    output = []
    for alert in db.scalars(select(ChartAlert).where(ChartAlert.status != "archived").order_by(
            ChartAlert.id)):
        version = db.scalar(select(ChartAlertVersion).where(
            ChartAlertVersion.alert_id == alert.id,
            ChartAlertVersion.version == alert.version))
        output.append({"id": alert.id, "name": alert.name, "version": alert.version,
                       "status": alert.status, "health": alert.health,
                       "health_reason": alert.health_reason,
                       "bound_revision_id": (version.market_identity or {}).get(
                           "composite_revision_id") if version else None})
    return output


def activate_candidate(run_id):
    """Explicit activation of one window candidate, with every rule verdict."""
    with transaction() as db:
        row = db.get(MarketSwitchRun, run_id)
        composite_id, target = row.composite_id, row.target_revision_id
        previous = db.get(MarketComposite, composite_id).active_revision_id
        before = _rule_snapshot(db, composite_id)
    error = None
    try:
        with transaction() as db:
            composite_revisions.activate(db, composite_id, target, {
                "request_id": "acceptance-head9c-activate-" + run_id,
                "expected_revision_id": previous})
    except Exception as failure:  # noqa: BLE001 - reported as evidence
        error = {"type": type(failure).__name__, "detail": str(failure)}
    with transaction() as db:
        composite = db.get(MarketComposite, composite_id)
        run = db.scalar(select(MarketSwitchRun).where(
            MarketSwitchRun.kind == switch_activation.KIND,
            MarketSwitchRun.composite_id == composite_id,
            MarketSwitchRun.target_revision_id == target))
        activation = db.get(CompositeActivation, target)
        notes = [row for row in db.scalars(select(Notification))
                 if (row.payload or {}).get("run_id") == (run.id if run else None)]
        outbox = {row.notification_id: {"id": row.id, "status": row.status,
                                       "attempts": row.attempts}
                  for row in db.scalars(select(Outbox))}
        return {"error": error, "head": head_note()["head"],
                "window": {"shadow_run_id": run_id, "previous_revision_id": previous,
                           "target_revision_id": target},
                "run": None if run is None else {
                    "id": run.id, "state": run.state, "phase": run.phase,
                    "attempts": run.attempts, "error_summary": run.error_summary},
                "active_revision_id": composite.active_revision_id,
                "activation": None if activation is None else {
                    "event_boundary": activation.event_boundary,
                    "input_revision": activation.input_revision,
                    "evidence": (activation.evidence or {}).get("switch")},
                "rules_before": before, "rules_after": _rule_snapshot(db, composite_id),
                "notifications": [{"id": row.id, "state": (row.payload or {}).get("state"),
                                   "attempts": (row.payload or {}).get("attempts"),
                                   "errors": (row.payload or {}).get("errors"),
                                   "counts": (row.payload or {}).get("counts")}
                                  for row in notes],
                "outbox": [outbox[row.id] for row in notes if row.id in outbox]}


def chunk_commit_then_die(run_id, chunk=40):
    """Delete one chunk (stats persisted in that transaction) and exit at once."""
    import os

    totals = _totals_from_run(run_id)
    stamp = now_ms()
    claimed = switch_runs.claim_retention(run_id, dry_run=False)
    applied = retention_window._apply_chunk(
        run_id=run_id, lower=retention_window.lower_bound(), limit=chunk, now=stamp,
        deadline=stamp + 60000, skip_minutes=set(), skip_revisions=set(), totals=totals)
    durable = dict(switch_runs.get(run_id).get("retention") or {})
    payload = {"head": head_note()["head"], "run_id": run_id,
               "claimed_batch": {key: (claimed or {}).get(key)
                                 for key in ("batch_id", "state", "dry_run", "attempts")},
               "chunk_deleted": applied["deleted"], "chunk_bytes": applied["bytes"],
               "durable_stats_after_commit": durable.get("stats"),
               "durable_state_after_commit": durable.get("state"),
               "note": "process exits immediately after the chunk commit, before release"}
    print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True, default=str))
    sys.stdout.flush()
    os._exit(0)


def _totals_from_run(run_id):
    segment = dict(switch_runs.get(run_id).get("retention") or {})
    previous = dict(segment.get("stats") or {})
    return {"rows": int(previous.get("rows") or 0), "bytes": int(previous.get("bytes") or 0),
            "deleted": {name: int((previous.get("deleted") or {}).get(name) or 0)
                        for name in retention_window.DELETION_ORDER}}


def deliver_outbox(run_id):
    """Mark the run Outbox row delivered; delivery is disabled in this instance."""
    with transaction() as db:
        note = db.scalar(select(Notification).where(
            Notification.payload["run_id"].as_string() == run_id))
        row = db.scalar(select(Outbox).where(Outbox.notification_id == note.id))
        row.status, row.lease_until = "accepted", None
        return {"run_id": run_id, "notification_id": note.id, "outbox_id": row.id,
                "status": row.status,
                "stimulus": "delivery disabled; row marked delivered"}


def outbox_state(run_id):
    if run_id is None:
        return {"run_id": None, "notification": None, "outbox": None}
    with transaction() as db:
        note = db.scalar(select(Notification).where(
            Notification.payload["run_id"].as_string() == run_id))
        if note is None:
            return {"run_id": run_id, "notification": None, "outbox": None}
        row = db.scalar(select(Outbox).where(Outbox.notification_id == note.id))
        return {"run_id": run_id, "notification_id": note.id,
                "outbox_rows": int(db.scalar(select(func.count()).select_from(Outbox).where(
                    Outbox.notification_id == note.id)) or 0),
                "outbox_id": row.id if row else None,
                "status": row.status if row else None,
                "attempts": row.attempts if row else None,
                "errors": [(entry["stage"], entry["type"], entry.get("seen"))
                           for entry in (note.payload or {}).get("errors") or []],
                "payload_attempts": (note.payload or {}).get("attempts"),
                "payload_state": (note.payload or {}).get("state")}


def g6_sequence(stages, shadow_run_id=None):
    """Repeated failures on one run; a new error key must requeue the outbox row."""
    from alerts import composite_alerts

    saved = state()
    if shadow_run_id:
        with transaction() as db:
            shadow = db.get(MarketSwitchRun, shadow_run_id)
            saved["failure_candidate"] = {"run_id": shadow.id,
                                          "revision": shadow.target_revision_id}
        fixtures.save_state(saved)
    candidate = saved["failure_candidate"]
    composite_id = saved["a"]["composite"]
    targets = {"metrics": (switch_activation, "consolidate_metrics"),
               "fence": (switch_activation, "freeze_previous"),
               "alerts": (composite_alerts, "rebind_active")}
    originals = {name: getattr(module, name) for module, name in targets.values()}
    steps = []
    try:
        for stage in stages:
            module, name = targets[stage]
            def broken(*args, _stage=stage, **kwargs):
                raise ValueError("acceptance injected failure at " + _stage)
            setattr(module, name, broken)
            failure = None
            try:
                with transaction() as db:
                    composite_revisions.activate(db, composite_id, candidate["revision"], {
                        "request_id": "acceptance-head9c-failure",
                        "expected_revision_id": db.get(
                            MarketComposite, composite_id).active_revision_id})
            except Exception as error:  # noqa: BLE001 - the failure is the evidence
                failure = {"type": type(error).__name__, "detail": str(error)}
            finally:
                setattr(module, name, originals[name])
            with transaction() as db:
                run = db.scalar(select(MarketSwitchRun).where(
                    MarketSwitchRun.kind == switch_activation.KIND,
                    MarketSwitchRun.composite_id == composite_id,
                    MarketSwitchRun.target_revision_id == candidate["revision"]))
                steps.append({"stage": stage, "failure": failure,
                              "run": None if run is None else {
                                  "id": run.id, "state": run.state, "phase": run.phase,
                                  "attempts": run.attempts,
                                  "retention": run.retention},
                              "outbox": outbox_state(run.id if run else None)})
    finally:
        for (module, name), value in zip(targets.values(), originals.values()):
            setattr(module, name, value)
    return {"head": head_note()["head"], "candidate": candidate, "steps": steps}

def drop_orphans():
    """Remove the fixture-only source series inserted for the dry-run candidates."""
    from sqlalchemy import text

    from alerts.source_registry import collection_identity

    ident = DatasetIdentity(source="oanda", channel="v20", environment="practice",
                            account_scope="public", provider_symbol="EUR_USD", basis="bid",
                            calendar_version="candidate-ny17-v1")
    series = collection_identity(ident).key
    with transaction() as db:
        removed = db.execute(text(
            "delete from market_source_minutes where source_id = :series"),
            {"series": series}).rowcount
        revisions = db.execute(text(
            "delete from market_source_minute_revisions where source_id = :series"),
            {"series": series}).rowcount
    return {"source_series": series, "source_minutes_removed": removed,
            "source_revisions_removed": revisions}


def victim_old_minutes(minutes=120, days_back=33):
    """Old minutes referenced by one unprotected revision: real, deletable rows.

    The retention pass only deletes a source revision whose referencing composite
    rows leave with it, so an unprotected revision must own these minutes.
    """
    from alerts import composite_aggregates, composite_preparation
    from alerts.confirmed_minutes import record
    from alerts.market_contracts import MinuteRow

    saved = state()
    composite_id = saved["a"]["composite"]
    with transaction() as db:
        items = composite_revisions.options(db, composite_id)["items"]
        chosen = items[0]
        mapping_id = next(item["id"] for item in chosen["mappings"] if item["reviewed"])
        revision_row = db.get(CompositeRevision,
                              db.get(MarketComposite, composite_id).active_revision_id)
        # The seam sits before the old minutes, so the confirmed tail the victim
        # owns covers them: the pass only deletes minutes a revision references.
        seam = int((saved["clock"] - 34 * DAY) // MIN * MIN)
        composite_revisions.create(db, composite_id, {
            "request_id": "acceptance-victim-revision-2",
            "expected_revision_id": revision_row.id,
            "history_version_id": chosen["version_id"],
            "mapping_id": mapping_id,
            "seam": seam,
            "allow_non_day_boundary": True,
            "reason": "验收：清理用的不受保护修订（旧分钟载体）",
        })
    with transaction() as db:
        victim = db.scalar(select(CompositeRevision.id).where(
            CompositeRevision.request_id == "acceptance-victim-revision-2"))
    prepared = fixtures.prepare(victim, saved["clock"], limit=60)
    for _ in range(60):
        with transaction() as db:
            prep_state = db.get(CompositePreparation, victim)
            done = prep_state.status == "queried"
        if done:
            break
        prepared = fixtures.prepare(victim, saved["clock"], limit=10)
    target = prepared and None
    with transaction() as db:
        revision = db.get(CompositeRevision, victim)
        dataset = db.get(MarketDataset, db.get(RealtimeMapping, revision.mapping_id)
                         .target_dataset_id)
        identity = DatasetIdentity.model_validate(dataset.identity)
    stop = int((saved["clock"] - int(days_back) * DAY) // MIN * MIN)
    start = stop - minutes * MIN
    rows = tuple(MinuteRow(timestamp=start + index * MIN,
                           open=f"{1.0995 + index * 1e-6:.5f}",
                           high=f"{1.0995 + index * 1e-6 + 4e-4:.5f}",
                           low=f"{1.0995 + index * 1e-6 - 4e-4:.5f}",
                           close=f"{1.0995 + index * 1e-6 + 2e-4:.5f}",
                           volume="3.0", complete=True)
                for index in range(minutes))
    batch = CandleBatch(identity=identity, window_start=start, window_end=stop,
                        observed_at=saved["clock"], checkpoint=stop,
                        result=RequestResult(status="data"), rows=rows,
                        volume_kind="price_count", volume_unit="quotes")
    from alerts.composite_inputs import apply_minutes

    with transaction() as db:
        applied = apply_minutes(db, record(db, batch), revision_id=victim,
                                reason="acceptance-retention-victim")
    drained = fixtures.drain(victim)
    with transaction() as db:
        prep = db.get(CompositePreparation, victim)
        return {"revision_id": victim, "seam": prepared, "window": [start, stop],
                "applied": [item for item in applied if item["revision_id"] == victim],
                "input_revision": prep.input_revision, "tasks": drained["tasks"],
                "frozen": bool((prep.state or {}).get("revision_frozen"))}

def b_calendar_reverse():
    """A calendar-different candidate for composite B: activation must pause, not move."""
    saved = state()
    composite_id = saved["b"]["composite"]
    with transaction() as db:
        items = composite_revisions.options(db, composite_id)["items"]
        chosen = next(item for item in items
                      if item["dataset_id"] == saved["b"]["series"]["dataset"])
        mapping_id = next(item["id"] for item in chosen["mappings"] if item["reviewed"])
        previous = db.get(MarketComposite, composite_id).active_revision_id
        revision = composite_revisions.create(db, composite_id, {
            "request_id": "acceptance-b-calendar-reverse",
            "expected_revision_id": previous,
            "history_version_id": chosen["version_id"],
            "mapping_id": mapping_id,
            "seam": chosen["recommended_seam"],
            "reason": "acceptance: opposite calendar candidate (utc0 -> ny17)",
        })
        ident, seam = revision.id, chosen["recommended_seam"]
    prepared = fixtures.prepare(ident, saved["clock"], limit=60)
    readiness = fixtures.settle(ident)
    with transaction() as db:
        before = _rule_snapshot(db, composite_id)
    error = None
    try:
        with transaction() as db:
            composite_revisions.activate(db, composite_id, ident, {
                "request_id": "acceptance-head9c-b-calendar",
                "expected_revision_id": previous})
    except Exception as failure:  # noqa: BLE001 - reported as evidence
        error = {"type": type(failure).__name__, "detail": str(failure)}
    with transaction() as db:
        composite = db.get(MarketComposite, composite_id)
        run = db.scalar(select(MarketSwitchRun).where(
            MarketSwitchRun.kind == switch_activation.KIND,
            MarketSwitchRun.composite_id == composite_id,
            MarketSwitchRun.target_revision_id == ident))
        activation = db.get(CompositeActivation, ident)
        return {"head": head_note()["head"], "error": error, "candidate": ident,
                "seam": seam, "preparation": prepared, "readiness": readiness,
                "run": None if run is None else {"id": run.id, "state": run.state,
                                                "phase": run.phase, "attempts": run.attempts},
                "active_revision_id": composite.active_revision_id,
                "activation": None if activation is None else {
                    "event_boundary": activation.event_boundary,
                    "evidence": (activation.evidence or {}).get("switch")},
                "rules_before": before, "rules_after": _rule_snapshot(db, composite_id)}

def g3_activate():
    cycle = switch_schedule.activation_cycle()
    saved = state()
    with transaction() as db:
        composite = db.get(MarketComposite, saved["a"]["composite"])
        runs = [{"id": row.id, "kind": row.kind, "state": row.state, "phase": row.phase,
                 "target_revision_id": row.target_revision_id,
                 "created_at": row.created_at} for row in db.scalars(select(MarketSwitchRun).where(
                     MarketSwitchRun.composite_id == saved["a"]["composite"]).order_by(
                         MarketSwitchRun.created_at.desc()).limit(4))]
        return {"activation_cycle": cycle, "active_revision_id": composite.active_revision_id,
                "runs": runs,
                "unlocked_runs": [item["id"] for item in switch_runs.unlocked_runs(limit=50)]}


def g4_dry_run(run_id=None):
    before = table_counts()
    report = retention_window.dry_run(run_id)
    after = table_counts()
    return {"before": before, "after": after,
            "delta": {name: after[name] - before[name] for name in before if name != "lower_bound"},
            "zero_deletion": all(after[name] == before[name] for name in before
                                 if name != "lower_bound"),
            "report": report, "inside_window": recent_counts()}


def g5_counts(database=None):
    if database:
        import os
        os.environ["ALERTS_DATABASE_URL"] = database
        from sqlalchemy import create_engine
        engine = create_engine(database)
        try:
            from alerts.backup import sql_counts
            with engine.connect() as connection:
                return {"database": database.split("@")[-1], "counts": sql_counts(connection)}
        finally:
            engine.dispose()
    return {"database": "configured", "counts": _configured_counts()}


def _configured_counts():
    from alerts.backup import sql_counts
    with transaction() as db:
        return sql_counts(db.connection())


def g5_marker(path, sha, verified_at, tables, backend, bytes_):
    marker = retention_window.save_restore_drill({
        "artifact": path, "sha256": sha, "verified_at": int(verified_at), "tables": int(tables),
        "backend": backend, "bytes": int(bytes_)})
    return {"marker": marker, "status": retention_window.restore_marker(),
            "schema": retention_window.schema_signature()}


def g5_execute(run_id=None, limit=None, chunk=None, budget_ms=None):
    before = table_counts()
    options = {}
    if limit:
        options["limit"] = limit
    if chunk:
        options["chunk"] = chunk
    if budget_ms:
        options["budget_ms"] = budget_ms
    report = retention_window.execute(run_id, **options)
    after = table_counts()
    return {"before": before, "after": after,
            "delta": {name: after[name] - before[name] for name in before if name != "lower_bound"},
            "report": report, "inside_window": recent_counts()}


def g5_status():
    with transaction() as db:
        runs = [{"id": row.id, "state": row.state,
                 "retention": row.retention} for row in db.scalars(select(MarketSwitchRun).order_by(
                     MarketSwitchRun.created_at)) ]
    return {"marker": retention_window.restore_marker(), "runs": runs,
            "counts": table_counts(), "inside_window": recent_counts()}


def g6_shadow():
    saved = state()
    published = fixtures.publish_forward(6, "v4")
    slot = switch_schedule.next_weekly() + 7 * DAY
    cycle = switch_schedule.shadow_cycle(now=slot, composites=[saved["a"]["composite"]],
                                         adapter=fixtures.AcceptanceAdapter(saved["clock"]),
                                         budget=4000)
    item = cycle["composites"][0]
    record = run_row(item["run_id"])
    saved["failure_candidate"] = {"run_id": record["id"],
                                  "revision": record["target_revision_id"]}
    fixtures.save_state(saved)
    return {"published_version": published, "cycle": cycle,
            "run": {"id": record["id"], "state": record["state"],
                    "target_revision_id": record["target_revision_id"],
                    "scheduled_for": record["scheduled_for"]},
            "report_status": (record.get("shadow_report") or {}).get("status")}


def g6_activate(attempts=3):
    """A failing activation stage: real rollback, real deduplicated report."""
    saved = state()
    candidate = saved["failure_candidate"]
    composite_id = saved["a"]["composite"]
    real = switch_activation.consolidate_metrics

    def broken(*args, **kwargs):
        raise ValueError("验收注入：指标水位重建失败")

    switch_activation.consolidate_metrics = broken
    failures = []
    try:
        for _ in range(attempts):
            try:
                with transaction() as db:
                    composite_revisions.activate(db, composite_id, candidate["revision"], {
                        "request_id": "acceptance-failure-" + candidate["run_id"],
                        "expected_revision_id": db.get(MarketComposite,
                                                       composite_id).active_revision_id})
            except Exception as error:  # noqa: BLE001 - the failure is the evidence
                failures.append({"type": type(error).__name__, "detail": str(error)})
    finally:
        switch_activation.consolidate_metrics = real
    with transaction() as db:
        run = db.scalar(select(MarketSwitchRun).where(
            MarketSwitchRun.kind == switch_activation.KIND,
            MarketSwitchRun.composite_id == composite_id,
            MarketSwitchRun.target_revision_id == candidate["revision"]))
        notifications = list(db.scalars(select(Notification)))
        outbox = list(db.scalars(select(Outbox)))
        run_notifications = [row for row in notifications
                             if (row.payload or {}).get("run_id") == (run.id if run else None)]
        run_outbox = [row for row in outbox if row.notification_id in {
            item.id for item in run_notifications}]
        return {"failures": failures,
                "run": None if run is None else {
                    "id": run.id, "state": run.state, "phase": run.phase,
                    "attempts": run.attempts, "error_summary": run.error_summary,
                    "retention": run.retention},
                "notifications": [{"id": row.id, "kind": row.kind,
                                   "run_id": (row.payload or {}).get("run_id"),
                                   "attempts": (row.payload or {}).get("attempts"),
                                   "state": (row.payload or {}).get("state"),
                                   "errors": (row.payload or {}).get("errors")}
                                  for row in notifications],
                "outbox": [{"id": row.id, "notification_id": row.notification_id}
                           for row in outbox],
                "run_notifications": [{"id": row.id, "run_id": (row.payload or {}).get("run_id"),
                                       "attempts": (row.payload or {}).get("attempts"),
                                       "state": (row.payload or {}).get("state")}
                                      for row in run_notifications],
                "run_outbox": [{"id": row.id, "notification_id": row.notification_id}
                               for row in run_outbox],
                "run_notification_rows": len(run_notifications),
                "run_outbox_rows": len(run_outbox),
                "unlocked_runs": [item["id"] for item in switch_runs.unlocked_runs(limit=50)],
                "retention_refusal": retention_window.dry_run(
                    None if run is None else run.id)}


def final_state():
    """Everything the report cites, in one read-only snapshot."""
    with transaction() as db:
        runs = [{"id": row.id, "kind": row.kind, "state": row.state, "phase": row.phase,
                 "attempts": row.attempts, "composite_id": row.composite_id,
                 "previous_revision_id": row.previous_revision_id,
                 "target_revision_id": row.target_revision_id,
                 "scheduled_for": row.scheduled_for, "retention": row.retention,
                 "error_summary": row.error_summary, "activation": row.activation}
                for row in db.scalars(select(MarketSwitchRun).order_by(MarketSwitchRun.created_at))]
        composites = [{"id": row.id, "active_revision_id": row.active_revision_id,
                       "dataset_id": row.dataset_id, "rules": row.rules}
                      for row in db.scalars(select(MarketComposite).order_by(MarketComposite.id))]
        revisions = [{"id": row.id, "composite_id": row.composite_id,
                      "history_version_id": row.history_version_id, "seam": row.seam,
                      "rules": row.rules, "activated_at": row.activated_at}
                     for row in db.scalars(select(CompositeRevision).order_by(
                         CompositeRevision.created_at))]
        preparations = [{"revision_id": row.revision_id, "status": row.status,
                         "input_revision": row.input_revision,
                         "confirmed_end": row.confirmed_end,
                         "frozen": bool((row.state or {}).get("revision_frozen")),
                         "fence": (row.state or {}).get("fence")}
                        for row in db.scalars(select(CompositePreparation))]
        alerts = [{"id": row.id, "name": row.name, "status": row.status, "version": row.version,
                   "health": row.health, "health_reason": row.health_reason,
                   "boundary": row.effective_at, "control_revision": row.control_revision,
                   "bound_revision_id": (db.scalar(select(ChartAlertVersion.market_identity).where(
                       ChartAlertVersion.alert_id == row.id,
                       ChartAlertVersion.version == row.version)) or {}).get(
                           "composite_revision_id")}
                  for row in db.scalars(select(ChartAlert).order_by(ChartAlert.created_at))]
        versions = [{"alert_id": row.alert_id, "version": row.version,
                     "bound_revision_id": (row.market_identity or {}).get("composite_revision_id"),
                     "effective_at": row.effective_at}
                    for row in db.scalars(select(ChartAlertVersion).order_by(
                        ChartAlertVersion.alert_id, ChartAlertVersion.version))]
        judgments = int(db.scalar(select(func.count()).select_from(CompositeJudgment)) or 0)
        judgments_by_outcome = dict(db.execute(select(CompositeJudgment.outcome, func.count())
                                               .group_by(CompositeJudgment.outcome)).all())
        notifications = dict(db.execute(select(Notification.kind, func.count())
                                        .group_by(Notification.kind)).all())
        outbox_rows = int(db.scalar(select(func.count()).select_from(Outbox)) or 0)
    return {"runs": runs, "composites": composites, "revisions": revisions,
            "preparations": preparations, "alerts": alerts, "alert_versions": versions,
            "judgments": judgments, "judgments_by_outcome": judgments_by_outcome,
            "notifications": notifications, "outbox": outbox_rows,
            "marker": retention_window.restore_marker(), "counts": table_counts(),
            "inside_window": recent_counts()}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("step", choices=(
        "g1-shadow", "g2-activation", "g2-fencing", "g2-pause", "g3-feed", "g3-shadow",
        "g3-activate", "g4-dry-run", "g5-counts", "g5-marker", "g5-execute", "g5-status",
        "g6-shadow", "g6-activate", "counts", "watermarks", "final", "run-report",
        "tamper-scope", "restore-scope", "g1-shadow-tampered-run",
        "g1-shadow-unrelated-run", "restore-unrelated", "head", "add-pause-rule",
        "seed-orphans", "activation-snapshot", "report-stimulus", "restore-report",
        "activate-candidate", "chunk-commit-then-die", "deliver-outbox", "outbox",
        "g6-sequence", "drop-orphans", "victim-old-minutes", "b-calendar-reverse"))
    parser.add_argument("--run-id")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--chunk", type=int)
    parser.add_argument("--budget-ms", type=int)
    parser.add_argument("--database")
    parser.add_argument("--path")
    parser.add_argument("--sha")
    parser.add_argument("--verified-at", type=int)
    parser.add_argument("--tables", type=int)
    parser.add_argument("--backend")
    parser.add_argument("--bytes", type=int)
    parser.add_argument("--attempts", type=int, default=3)
    parser.add_argument("--composite")
    parser.add_argument("--slot", type=int, help="explicit weekly window start (ms)")
    parser.add_argument("--minutes", type=int, default=120)
    parser.add_argument("--days-back", type=float, default=33)
    parser.add_argument("--stages", default="metrics,metrics,fence")
    parser.add_argument("--version-key", default="v3")
    parser.add_argument("--days", type=float, default=12)
    args = parser.parse_args(argv)
    steps = {
        "g1-shadow": lambda: g1_shadow(args.slot),
        "g1-shadow-tampered-run": lambda: g1_shadow_with_tamper(
            args.version_key, args.days, args.slot, "scope"),
        "g1-shadow-unrelated-run": lambda: g1_shadow_with_tamper(
            args.version_key, args.days, args.slot, "unrelated"),
        "restore-unrelated": lambda: restore_unrelated(),
        "g2-activation": lambda: g2_activation(args.run_id),
        "g2-fencing": lambda: g2_fencing(args.run_id),
        "g2-pause": lambda: g2_pause_branch(),
        "g3-feed": lambda: g3_feed(),
        "g3-shadow": lambda: g3_shadow(args.version_key, args.days, args.slot),
        "g3-activate": lambda: g3_activate(),
        "g4-dry-run": lambda: g4_dry_run(args.run_id),
        "g5-counts": lambda: g5_counts(args.database),
        "g5-marker": lambda: g5_marker(args.path, args.sha, args.verified_at, args.tables,
                                       args.backend, args.bytes),
        "g5-execute": lambda: g5_execute(args.run_id, args.limit, args.chunk, args.budget_ms),
        "g5-status": lambda: g5_status(),
        "g6-shadow": lambda: g6_shadow(),
        "g6-activate": lambda: g6_activate(args.attempts),
        "counts": lambda: table_counts(),
        "watermarks": lambda: watermarks(args.composite or state()["a"]["composite"]),
        "final": lambda: final_state(),
        "head": lambda: head_note(),
        "add-pause-rule": lambda: add_pause_rule(),
        "seed-orphans": lambda: seed_orphan_minutes(args.minutes, args.days_back),
        "activation-snapshot": lambda: activation_snapshot(),
        "report-stimulus": lambda: set_report_state(args.run_id, "not_ready"),
        "restore-report": lambda: set_report_state(args.run_id, "restore"),
        "activate-candidate": lambda: activate_candidate(args.run_id),
        "chunk-commit-then-die": lambda: chunk_commit_then_die(args.run_id, args.chunk or 40),
        "deliver-outbox": lambda: deliver_outbox(args.run_id),
        "outbox": lambda: outbox_state(args.run_id),
        "b-calendar-reverse": lambda: b_calendar_reverse(),
        "drop-orphans": lambda: drop_orphans(),
        "victim-old-minutes": lambda: victim_old_minutes(args.minutes, args.days_back),
        "g6-sequence": lambda: g6_sequence(
            [item.strip() for item in args.stages.split(",") if item.strip()],
            args.run_id),
        "run-report": lambda: run_report(args.run_id),
        "tamper-scope": lambda: tamper_scope(),
        "restore-scope": lambda: restore_scope(),
    }
    print(json.dumps(steps[args.step](), ensure_ascii=False, indent=2, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
