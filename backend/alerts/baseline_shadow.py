"""Sunday candidate preparation and shadow differences for fixed composite baselines.

A shadow run prepares the newest published history version as an explicit
candidate revision with its period and indicator artifacts, compares it with the
active revision, and records the evidence on the persisted switch run. The
active revision, alert bindings and published charts are only read.

Report schema (`baseline-shadow-v1`):

* `status` / `ready` / `reasons` -- ready, not_ready or failed; each reason carries a
  stable `code` and a short `detail`.
* `run` -- the persisted switch run this report is written to.
* `history_version` -- candidate and active fixed history versions.
* `revision` -- candidate and active revision ids, seams and changed rules.
* `preparation` -- readiness snapshot plus per-frame aggregate progress.
* `bars` -- per frame same/added/missing/OHLC-changed bar counts and the largest
  price difference, split into the shared history and target windows.
* `indicators` -- every configured indicator: candidate and current tail values
  and their difference.
* `gaps` -- contiguous missing confirmed minutes and uncovered intervals.
* `paused_rules` -- alerts that cannot keep running on the candidate, with one
  reason per cause (bound input missing, source incompatible, indicator missing,
  geometry that cannot be relocated).
* `bindings` -- digest proof that the live bindings did not move.
"""

import hashlib
import json

from sqlalchemy import select

from . import switch_runs
from .chart_data import FRAMES
from .composite_aggregates import aggregate_tick
from .composite_aggregates import read as aggregate_read
from .composite_aggregates import report as aggregate_report
from .composite_revisions import affected_rules, create, options, owned, readiness
from .composite_revisions import preparation_tick as revision_tick
from .history_artifacts import read_artifact
from .history_maintenance import latest_version
from .storage import (
    ChartAlert,
    ChartAlertVersion,
    ChartPublication,
    CompositeMinute,
    CompositePreparation,
    CompositeRevision,
    FixedIndicatorRun,
    HistoryReclamation,
    HistoryVersion,
    Instrument,
    MarketComposite,
    MarketDataset,
    Preference,
    RealtimeMapping,
    now_ms,
    transaction,
)

SCHEMA = "baseline-shadow-v1"
KIND = "baseline_shadow"
MAX_BARS = 60
MAX_SCAN_MINUTES = 32 * 1440
BUDGET = 256
LIVE_STATES = ("activating", "succeeded")
CRITICAL = ("alert_versions", "publications")


def _reason(code, detail):
    return {"code": code, "detail": detail}


def _digest(rows):
    raw = json.dumps(rows, sort_keys=True, separators=(",", ":"), default=str).encode()
    return hashlib.sha256(raw).hexdigest()


TABLES = ("alerts", "alert_versions", "publications", "realtime_preferences")


def _snapshot(db, model, *where):
    order = [getattr(model, column.name) for column in model.__table__.primary_key.columns]
    columns = [column.name for column in model.__table__.columns]
    query = select(model).order_by(*order) if not where else (
        select(model).where(*where).order_by(*order))
    return [{name: getattr(row, name) for name in columns} for row in db.scalars(query)]


def scope(db, composite_id):
    """Only this composite's own rows: its instruments and its bound alert versions.

    Unrelated symbols publish charts and rules all day long; a Sunday candidate
    must not fail because another instrument moved. Everything that belongs to
    this composite stays inside the snapshot.
    """
    composite = owned(db, composite_id)
    instruments = {composite.instrument_id}
    dataset = db.get(MarketDataset, composite.dataset_id)
    if dataset is not None:
        instruments.add(dataset.instrument_id)
    mapping = db.get(RealtimeMapping, composite.mapping_id)
    target = db.get(MarketDataset, mapping.target_dataset_id) if mapping else None
    if target is not None:
        instruments.add(target.instrument_id)
    ordered = sorted(instruments)
    alert_ids = sorted({version.alert_id for version in db.scalars(
        select(ChartAlertVersion).where(
            ChartAlertVersion.market_identity["composite_id"].as_string() == composite_id))})
    return {"instruments": ordered, "alert_ids": alert_ids,
            "realtime_keys": ["managed_realtime:" + instrument for instrument in ordered]}


def bindings(composite_id):
    """Content snapshot of every live binding of this composite, and nothing else."""
    with transaction() as db:
        bounds = scope(db, composite_id)
        return {
            "scope": bounds,
            "active_revision_id": db.get(MarketComposite, composite_id).active_revision_id,
            "alerts": _snapshot(db, ChartAlert, ChartAlert.id.in_(bounds["alert_ids"])),
            "alert_versions": _snapshot(db, ChartAlertVersion,
                                        ChartAlertVersion.alert_id.in_(bounds["alert_ids"])),
            "publications": _snapshot(db, ChartPublication,
                                      ChartPublication.instrument_id.in_(bounds["instruments"])),
            "realtime_preferences": [{"key": row.key, "value": row.value} for row in db.scalars(
                select(Preference).where(Preference.key.in_(bounds["realtime_keys"])).order_by(
                    Preference.key))],
        }


def binding_report(before, after):
    tables = {name: {"rows": len(after[name]), "digest": _digest(after[name]),
                     "unchanged": before[name] == after[name]}
              for name in TABLES}
    active = {"before": before["active_revision_id"], "after": after["active_revision_id"]}
    active["unchanged"] = active["before"] == active["after"]
    critical = active["unchanged"] and all(tables[name]["unchanged"] for name in CRITICAL)
    return {"tables": tables, "active_revision_id": active, "critical_unchanged": critical,
            "scope": after.get("scope", {})}


def _window(start, end, bars=None):
    window = {"start": start, "end": end}
    if bars is not None:
        window["bars"] = bars
    return window


def candidate_plan(db, composite_id):
    """Newest usable published history version plus an explicit candidate seam."""
    from .composite_revisions import now_ms as revision_now

    composite = owned(db, composite_id)
    active = db.get(CompositeRevision, composite.active_revision_id)
    if active is None:
        return {"blocked": _reason("active_revision_missing", "组合没有当前有效修订")}
    newest = latest_version(db, composite.dataset_id)
    if newest is None:
        return {"blocked": _reason("no_history_version", "没有可用的已发布历史版本")}
    # The same cutoff clock revision creation validates the seam against.
    cutoff = (revision_now() - 5000) // 60000 * 60000
    chosen = next((item for item in options(db, composite_id)["items"]
                   if item["version_id"] == newest.id), None)
    reviewed = [mapping for mapping in chosen["mappings"] if mapping["reviewed"]] if chosen else []
    if chosen is None or chosen["recommended_seam"] is None or not reviewed:
        return {"blocked": _reason("no_candidate_base",
                                   "最新已发布历史版本缺少推荐接缝或已审核实时映射")}
    if chosen["recommended_seam"] > cutoff:
        return {"blocked": _reason("candidate_beyond_cutoff",
                                   "最新历史版本尚未进入本轮准备截止")}
    from .live_window import lower_bound

    if chosen["recommended_seam"] < lower_bound(revision_now()):
        return {"blocked": _reason("history_outside_live_window",
                                   "最新历史未覆盖30天实时窗口，需更新历史基线")}
    chosen = {**chosen, "mapping_id": reviewed[0]["id"]}
    return {
        "active_revision_id": active.id,
        "active_history_version_id": active.history_version_id,
        "active_seam": active.seam,
        "version_id": chosen["version_id"],
        "dataset_id": chosen["dataset_id"],
        "mapping_id": chosen["mapping_id"],
        "seam": chosen["recommended_seam"],
        "latest_available_version_id": newest.id if newest else None,
        "request_id": "shadow:" + _digest([composite_id, chosen["version_id"],
                                            chosen["recommended_seam"]])[:56],
    }


def create_candidate(composite_id, plan):
    with transaction() as db:
        revision = create(db, composite_id, {
            "request_id": plan["request_id"],
            "expected_revision_id": plan["active_revision_id"],
            "history_version_id": plan["version_id"],
            "mapping_id": plan["mapping_id"],
            "seam": plan["seam"],
            "reason": "周日候选基线：采用最新已发布历史版本，不改变有效绑定",
        })
        return revision.id


def advance(candidate_id, *, adapter=None, budget=BUDGET):
    """Drive the existing bounded workers; the candidate is never activated."""
    from .composite_preparation import preparation_tick
    from .fixed_indicators import indicator_tick

    for _ in range(budget):
        worked = bool(revision_tick())
        worked = bool(aggregate_tick(revision_id=candidate_id)) or worked
        worked = bool(indicator_tick()) or worked
        if adapter is not None:
            worked = bool(preparation_tick(adapter, candidate_id)) or worked
        if not worked:
            return


def _preparation_reasons(progress, aggregates):
    reasons = []
    if progress.get("query_error"):
        reasons.append(_reason("preparation_error", str(progress["query_error"])))
    if progress["status"] != "ready":
        reasons.append(_reason("preparation_" + progress["status"],
                               "候选修订尚未完成固定M1、周期和指标准备"))
    if not progress["periods_ready"]:
        reasons.append(_reason("periods_not_published", "候选周期的固定产物尚未齐备"))
    for frame in aggregates:
        if frame["status"] != "caught_up":
            reasons.append(_reason("aggregates_behind", frame["timeframe"] + "：" + frame["status"]))
    for item in progress["indicators"]:
        if item["status"] != "complete":
            reasons.append(_reason("indicator_pending", item["timeframe"] + "/"
                                   + str(item["spec"].get("name")) + "：" + str(item["status"])))
    return reasons


def _published(db, version_id, frame):
    """Readable fixed period artifact; missing or unreclaimed states are facts."""
    from .storage import HistoryArtifact

    return db.scalar(select(HistoryArtifact.id).where(
        HistoryArtifact.version_id == version_id, HistoryArtifact.timeframe == frame,
        HistoryArtifact.status == "published")) is not None


def _price(value):
    return None if value is None else float(value)


def _compare(active_bars, candidate_bars):
    active = {bar["start"]: bar for bar in active_bars}
    candidate = {bar["start"]: bar for bar in candidate_bars}
    shared = sorted(set(active) & set(candidate))
    changed, delta = 0, 0.0
    for start in shared:
        gap, differs = 0.0, False
        for name in ("open", "high", "low", "close"):
            left, right = _price(active[start].get(name)), _price(candidate[start].get(name))
            if left is None or right is None or left != right:
                differs = True
            gap = max(gap, abs((left or 0.0) - (right or 0.0)))
        changed += int(differs)
        delta = max(delta, gap)
    return {"same": len(shared) - changed, "changed": changed,
            "added": len(set(candidate) - set(active)),
            "missing": len(set(active) - set(candidate)),
            "max_price_delta": round(delta, 10)}


def _history_segment(db, frame, active, candidate, end):
    window = _window(None, end, MAX_BARS)
    if end <= 0:
        return {"status": "empty", "reason": "两个修订在接缝前没有可比较的历史柱",
                "window": window}
    bars = {}
    for name, version_id in (("active", active.history_version_id),
                             ("candidate", candidate.history_version_id)):
        try:
            bars[name] = read_artifact(db, version_id, frame, end=end, limit=MAX_BARS,
                                       newest_first=True)
        except ValueError as error:
            return {"status": "unavailable", "window": window,
                    "reason": name + "：" + str(error)}
    window["start"] = bars["active"][0]["start"] if bars["active"] else end
    return {"status": "compared", "window": window,
            **_compare(bars["active"], bars["candidate"])}


def _target_segment(db, frame, active, candidate, active_prep, candidate_prep, start, end):
    window = _window(start, end, MAX_BARS)
    if end <= start:
        return {"status": "empty", "window": window,
                "reason": "两个修订没有共同的已确认目标分钟"}
    stamp, bars = now_ms(), {}
    for name, revision, prep in (("active", active, active_prep),
                                 ("candidate", candidate, candidate_prep)):
        rows = aggregate_read(db, revision.id, frame, prep.input_revision,
                              before=end, count=MAX_BARS, now=stamp)
        if rows is None:
            return {"status": "unavailable", "window": window,
                    "reason": name + " 修订的周期聚合尚未到达其固定输入"}
        bars[name] = [bar for bar in rows if bar["start"] >= start]
    return {"status": "compared", "window": window,
            **_compare(bars["active"], bars["candidate"])}


def _bars(db, active, candidate, active_prep, candidate_prep):
    history_end = min(active.seam, candidate.seam)
    target_start = max(active.seam, candidate.seam)
    target_end = min(active_prep.confirmed_end, candidate_prep.confirmed_end)
    frames = [{"timeframe": frame,
               "history": _history_segment(db, frame, active, candidate, history_end),
               "target": _target_segment(db, frame, active, candidate, active_prep,
                                         candidate_prep, target_start, target_end)}
              for frame in FRAMES]
    return {"overlap": {"history_end": history_end, "target_start": target_start,
                        "target_end": target_end},
            "frames": frames}


def _spec_key(timeframe, spec):
    from .indicator_state import IndicatorState

    normalized = IndicatorState(spec).spec
    raw = json.dumps([timeframe, normalized], sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(raw).hexdigest()


def _matching_run(db, revision_id, timeframe, spec):
    if not revision_id:
        return None
    wanted = _spec_key(timeframe, spec)
    rows = db.scalars(select(FixedIndicatorRun).where(
        FixedIndicatorRun.revision_id == revision_id,
        FixedIndicatorRun.timeframe == timeframe).order_by(FixedIndicatorRun.updated_at.desc()))
    return next((run for run in rows if _spec_key(timeframe, run.spec) == wanted), None)


def _tail(db, run):
    from .fixed_indicators import outputs

    if run is None:
        return {"status": "absent", "has_value": False}
    rows = outputs(db, run, max(0, run.cursor - 86400000), run.cursor) if run.cursor > 0 else []
    initialized = [row for row in rows if row.get("initialized")]
    last = initialized[-1] if initialized else None
    return {"status": run.status, "has_value": last is not None, "run_id": run.id,
            "cursor": run.cursor, "target_end": run.target_end,
            "start": last["start"] if last else None, "end": last["end"] if last else None,
            "values": last["values"] if last else None}


def _difference(candidate_tail, current_tail):
    if not candidate_tail.get("values") or not current_tail.get("values"):
        return {"comparable": False}
    values = {}
    for name, value in candidate_tail["values"].items():
        other = current_tail["values"].get(name)
        delta = None if value is None or other is None else round(_price(value) - _price(other), 10)
        values[name] = {"candidate": value, "current": other, "delta": delta}
    return {"comparable": True, "values": values}


def _indicators(db, active, progress):
    entries = []
    for item in progress["indicators"]:
        candidate_run = db.get(FixedIndicatorRun, item["run_id"]) if item["run_id"] else None
        current_run = _matching_run(db, active.id, item["timeframe"], item["spec"])
        candidate_tail, current_tail = _tail(db, candidate_run), _tail(db, current_run)
        entries.append({"timeframe": item["timeframe"], "indicator": item["spec"].get("name"),
                        "candidate": candidate_tail, "current": current_tail,
                        "difference": _difference(candidate_tail, current_tail)})
    return entries


def _gaps(db, active, candidate, candidate_prep):
    from .composite_series import _closed

    active_version = db.get(HistoryVersion, active.history_version_id)
    candidate_version = db.get(HistoryVersion, candidate.history_version_id)
    target = db.get(MarketDataset, db.get(RealtimeMapping, candidate.mapping_id).target_dataset_id)
    instrument = db.get(Instrument, target.instrument_id)
    end = min(candidate_prep.confirmed_end, candidate_prep.cutoff)
    start = max(candidate.seam, end - MAX_SCAN_MINUTES * 60000)
    observed = set(db.scalars(select(CompositeMinute.start).where(
        CompositeMinute.revision_id == candidate.id,
        CompositeMinute.start >= start, CompositeMinute.start < end)))
    segment = {"profile": instrument.calendar_profile}
    phase = candidate.rules["aggregation_calendar"]
    missing, run_start, expected = [], None, 0
    for at in range(start, end, 60000):
        known = _closed(at, segment, phase)
        expected += int(known)
        if known and at not in observed:
            run_start = at if run_start is None else run_start
        elif run_start is not None:
            missing.append({"start": run_start, "end": at, "minutes": (at - run_start) // 60000})
            run_start = None
    if run_start is not None:
        missing.append({"start": run_start, "end": end, "minutes": (end - run_start) // 60000})
    uncovered = []
    if candidate_version.start > active_version.start:
        uncovered.append({"segment": "history", "start": candidate_version.start,
                          "end": active_version.start,
                          "reason": "候选固定历史起点更晚，此前区段不受候选覆盖"})
    if candidate_prep.confirmed_end < candidate_prep.cutoff:
        uncovered.append({"segment": "target", "start": candidate_prep.confirmed_end,
                          "end": candidate_prep.cutoff, "reason": "准备截止前尚无来源确认分钟"})
    return {"scanned": {"start": start, "end": end, "expected_minutes": expected,
                        "observed_minutes": len(observed)},
            "missing_minutes": missing, "uncovered": uncovered}


def _geometry_reason(config, bound, candidate, candidate_version):
    if bound is None:
        return None
    keys = ("aggregation_calendar", "floor")
    if {key: candidate.rules.get(key) for key in keys} != {
            key: bound.rules.get(key) for key in keys}:
        return "候选聚合日历与规则绑定的修订不同，已有时点无法按原几何重定位"
    if config.calculation_origin is not None and candidate_version.start > config.calculation_origin:
        return "候选固定历史起点晚于规则计算起点"
    if config.condition.offset is not None:
        if candidate_version.start + config.warmup() * 60000 > candidate.seam:
            return "候选接缝前历史不足以重建ATR参考柱"
    return None


def _paused_rules(db, composite_id, candidate, progress, candidate_version):
    from .chart_alert_service import AlertConfig

    mapping = db.get(RealtimeMapping, candidate.mapping_id)
    target = db.get(MarketDataset, mapping.target_dataset_id)
    prepared = {_spec_key(item["timeframe"], item["spec"]): item["status"]
                for item in progress["indicators"]}
    output = []
    for version, alert in affected_rules(db, composite_id):
        config = AlertConfig.model_validate(version.config)
        reasons, bound = [], db.get(
            CompositeRevision, version.market_identity.get("composite_revision_id") or "")
        if bound is None or bound.composite_id != composite_id:
            reasons.append(_reason("bound_revision_missing", "规则绑定的组合修订不存在"))
            bound = None
        else:
            history = db.get(HistoryVersion, bound.history_version_id)
            bound_mapping = db.get(RealtimeMapping, bound.mapping_id)
            bound_target = db.get(MarketDataset, bound_mapping.target_dataset_id) if bound_mapping else None
            if (history is None or history.status != "published"
                    or db.get(HistoryReclamation, history.id)
                    or not _published(db, history.id, "M1")):
                reasons.append(_reason("source_incompatible", "规则绑定的固定历史已不可读"))
            elif bound_target is None or bound_target.identity != target.identity:
                reasons.append(_reason("source_incompatible", "规则绑定的实时目标与候选映射不同"))
        for spec in config.indicators():
            key = _spec_key(config.timeframe, spec.model_dump(exclude={"output"}))
            if prepared.get(key) != "complete":
                reasons.append(_reason("indicator_missing", config.timeframe + "/" + spec.name
                                       + " 在候选修订上没有已完成值"))
        geometry = _geometry_reason(config, bound, candidate, candidate_version)
        if geometry:
            reasons.append(_reason("geometry_not_relocatable", geometry))
        output.append({"alert_id": alert.id, "name": alert.name, "alert_version": alert.version,
                       "bound_revision_id": version.market_identity.get("composite_revision_id"),
                       "will_pause": bool(reasons), "reasons": reasons})
    return output


def differences(db, composite_id, candidate_id, progress):
    """Every shadow comparison; pure reads inside the caller's transaction."""
    composite = owned(db, composite_id)
    active = db.get(CompositeRevision, composite.active_revision_id)
    candidate = db.get(CompositeRevision, candidate_id)
    active_prep = db.get(CompositePreparation, active.id)
    candidate_prep = db.get(CompositePreparation, candidate.id)
    if active_prep is None or candidate_prep is None:
        raise ValueError("修订准备记录缺失")
    version = db.get(HistoryVersion, candidate.history_version_id)
    return {"bars": _bars(db, active, candidate, active_prep, candidate_prep),
            "indicators": _indicators(db, active, progress),
            "gaps": _gaps(db, active, candidate, candidate_prep),
            "paused_rules": _paused_rules(db, composite_id, candidate, progress, version)}


def _run(run_id, scheduled_for, composite_id, previous_revision_id):
    if run_id:
        record = switch_runs.get(run_id)
        if record is None:
            raise ValueError("切换运行不存在：" + str(run_id))
    else:
        stamp = now_ms() if scheduled_for is None else scheduled_for
        record = switch_runs.start(KIND, composite_id=composite_id,
                                   previous_revision_id=previous_revision_id,
                                   scheduled_for=stamp)
    if record["state"] in ("failed", "partial"):
        record = switch_runs.retry(record["id"], phase="shadow")
    return record


def shadow(composite_id, *, scheduled_for=None, run_id=None, adapter=None, budget=BUDGET):
    """Prepare the Sunday candidate, compare it, and persist the report on its run."""
    started = now_ms()
    before = bindings(composite_id)
    report = {"schema": SCHEMA, "started_at": started, "composite_id": composite_id,
              "status": "failed", "ready": False, "reasons": []}
    try:
        record = _run(run_id, scheduled_for, composite_id, before["active_revision_id"])
        report["run"] = {"id": record["id"], "kind": record["kind"], "state": record["state"],
                         "attempts": record["attempts"], "scheduled_for": record["scheduled_for"]}
        if record["state"] in LIVE_STATES:
            report["reasons"].append(_reason("run_not_shadowable",
                                             "切换运行已进入激活阶段，不能覆盖其 shadow 报告"))
            return _finish(report, before, composite_id, record, None)
        with transaction() as db:
            plan = candidate_plan(db, composite_id)
            active = db.get(CompositeRevision, plan.get("active_revision_id") or before["active_revision_id"])
            report["history_version"] = {
                "latest_available_version_id": plan.get("latest_available_version_id"),
                "candidate_version_id": plan.get("version_id"),
                "active_version_id": active.history_version_id if active else None,
                "same_version": plan.get("version_id") == (active.history_version_id if active else None),
            }
        if "blocked" in plan:
            report["reasons"].append(plan["blocked"])
            report["status"] = "not_ready"
            return _finish(report, before, composite_id, record, plan)
        with transaction() as db:
            report["revision"] = _revision_snapshot(db, composite_id, plan)
        candidate_id = create_candidate(composite_id, plan)
        switch_runs.record_target(record["id"], candidate_id,
                                  previous_revision_id=plan["active_revision_id"])
        advance(candidate_id, adapter=adapter, budget=budget)
        with transaction() as db:
            candidate = db.get(CompositeRevision, candidate_id)
            progress = readiness(db, candidate)
            aggregates = aggregate_report(db, candidate_id, progress["input_revision"] or 0)
            report["preparation"] = {**progress, "aggregates": aggregates}
            report.update(differences(db, composite_id, candidate_id, progress))
            report["reasons"] = _preparation_reasons(progress, aggregates)
        report["ready"] = not report["reasons"]
        report["status"] = "ready" if report["ready"] else "not_ready"
        report["revision"]["candidate_revision_id"] = candidate_id
        return _finish(report, before, composite_id, record, candidate_id)
    except Exception as error:  # noqa: BLE001 - the run must record its own failure
        report["status"], report["ready"] = "failed", False
        report["error"] = {"type": type(error).__name__, "detail": str(error)}
        report["reasons"].append(_reason("shadow_failed", type(error).__name__ + ": " + str(error)))
        return _finish(report, before, composite_id, report.get("run"), None)


def _revision_snapshot(db, composite_id, plan):
    active = db.get(CompositeRevision, plan["active_revision_id"])
    return {"active_revision_id": active.id, "active_seam": active.seam,
            "candidate_revision_id": None, "candidate_seam": plan["seam"],
            "request_id": plan["request_id"],
            "history_version_id": plan["version_id"], "mapping_id": plan["mapping_id"]}


def _finish(report, before, composite_id, record, candidate_id):
    after = bindings(composite_id)
    report["bindings"] = binding_report(before, after)
    if not report["bindings"]["critical_unchanged"]:
        report["status"], report["ready"] = "failed", False
        report["reasons"].append(_reason("binding_changed",
                                         "有效绑定在 shadow 运行期间发生变化"))
    report["finished_at"] = now_ms()
    if record is not None and record.get("state") not in LIVE_STATES:
        record = switch_runs.record_shadow(record["id"], report)
        if report["status"] != "ready":
            record = switch_runs.set_state(record["id"], "failed", phase="shadow_" + report["status"],
                                  error_summary={"status": report["status"],
                                                 "candidate_revision_id": candidate_id,
                                                 "reasons": report["reasons"][:8]})
            report["run"] = {**report["run"], "state": "failed"}
            from . import composite_alerts, switch_notice
            from .live_window import lower_bound

            with transaction() as db:
                composite = db.get(MarketComposite, composite_id)
                expired_rules = []
                lower = lower_bound()
                for version, alert in composite_alerts.bound_rules(db, composite_id, lock=True):
                    revision = db.get(CompositeRevision,
                                      version.market_identity.get("composite_revision_id"))
                    if revision is None or revision.seam < lower:
                        expired_rules.append((version, alert))
                paused = composite_alerts.pause(db, expired_rules,
                    reason="历史基线未覆盖实时窗口，暂停等待重建", run_id=record["id"])
                switch_notice.record(db, run=record, stage="shadow",
                    reasons=[{"stage": "shadow", "scope": composite_id,
                              "type": item["code"], "reason": item["detail"]}
                             for item in report["reasons"]],
                    counts={"sources": 1, "rules": len(affected_rules(db, composite_id)),
                            "paused": len(paused), "active_revision_id": composite.active_revision_id})
        else:
            report["run"] = {**report["run"], "state": record["state"]}
    return report
