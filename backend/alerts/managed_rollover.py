"""Maintenance-driven baseline rotation on the existing revision workers.

HistoryRun completion is the durable trigger. Notifications only shorten the
poll delay; a restart reconciles the same candidate request and shadow run.
The user's saved continuation mapping and realtime choice remain authoritative.
"""

import logging

from sqlalchemy import select

from . import baseline_shadow, composite_alerts, managed_continuation
from .composite_definitions import key
from .composite_inputs import frozen
from .config import settings
from .storage import (
    CompositePreparation,
    CompositeRevision,
    HistoryArtifact,
    HistoryReclamation,
    HistoryRun,
    HistoryVersion,
    MarketComposite,
    MarketDataset,
    MarketSwitchRun,
    Preference,
    RealtimeMapping,
    now_ms,
    transaction,
)

log = logging.getLogger(__name__)
KIND = "managed_rollover"
STATUS_PREFIX = "managed_rollover:"
BATCH_SIZE = 20


class Deferred(ValueError):
    """A protection gate; no activation attempt or alert mutation is consumed."""


def status(db, composite_id):
    row = db.get(Preference, STATUS_PREFIX + composite_id)
    composite = db.get(MarketComposite, composite_id)
    active = db.get(CompositeRevision, composite.active_revision_id) if composite else None
    return window_warning(dict(row.value) if row else {"status": "idle"}, active.seam if active else None)


def window_warning(value, seam, *, now=None):
    """Compute age on reads so an unchanged deferral cannot hide the deadline."""
    from .live_window import WINDOW_MS

    if seam is None:
        return value
    expires = seam + WINDOW_MS
    remaining = expires - (now_ms() if now is None else now)
    attention = value.get("status") == "deferred" and remaining <= 3 * 86400000
    warning = None
    if attention:
        warning = ("当前基线已超出30天实时窗口，请处理暂缓原因并更新基线" if remaining <= 0 else
                   "当前基线将在3天内达到30天实时窗口，请处理暂缓原因并更新基线")
    return {**value, "window_expires_at": expires, "window_remaining_ms": max(0, remaining),
            "requires_attention": attention, "warning": warning}


def _status(db, composite_id, state, reason=None, **facts):
    value = {"status": state, "reason": reason, **facts}
    row = db.get(Preference, STATUS_PREFIX + composite_id)
    # Avoid writing every poll (and changing the UI time) for an unchanged state.
    if row and {k: v for k, v in row.value.items() if k != "updated_at"} == value:
        return
    value["updated_at"] = now_ms()
    if row:
        row.value = value
    else:
        db.add(Preference(key=STATUS_PREFIX + composite_id, value=value))


def eligible(db, composite):
    dataset = db.get(MarketDataset, composite.dataset_id)
    if not dataset or dataset.identity.get("mode", "base_m1") != "base_m1":
        raise Deferred("此维护模式不支持实时基线轮换")
    current = managed_continuation.report(db, dataset.id)
    if not current["enabled"]:
        raise Deferred("实时流已关闭")
    if not current["supported"] or not current["ready_to_enable"]:
        raise Deferred(current["reason"] or "默认实时映射暂不可用")
    selected = current["default_mapping_id"]
    if not current["composite"] or current["composite"]["id"] != composite.id:
        raise Deferred("默认实时接续配置已改变")
    active = db.get(CompositeRevision, composite.active_revision_id)
    if not active or active.mapping_id != selected:
        raise Deferred("当前修订与默认实时映射不一致")
    return active, selected


def successful_versions(db, dataset_id):
    """Newest-first complete results; callers still check coverage/readability."""
    versions = db.scalars(select(HistoryVersion).join(
        HistoryRun, HistoryRun.version_id == HistoryVersion.id).where(
            HistoryVersion.dataset_id == dataset_id,
            HistoryVersion.status == "published", HistoryRun.completed_at.is_not(None),
            HistoryRun.desired_state == "running",
            ~select(HistoryReclamation.version_id).where(
                HistoryReclamation.version_id == HistoryVersion.id).exists(),
        ).order_by(HistoryVersion.end.desc(), HistoryVersion.published_at.desc(),
                   HistoryVersion.id.desc()))
    for version in versions:
        if version.manifest.get("result") == "partial":
            continue
        requested = set(version.manifest.get("maintenance", {}).get("timeframes", ["M1"])) | {"M1"}
        artifacts = {item.timeframe: item for item in db.scalars(select(HistoryArtifact).where(
            HistoryArtifact.version_id == version.id))}
        if all(frame in artifacts and artifacts[frame].status == "published"
               and artifacts[frame].count > 0 for frame in requested):
            yield version


def successful_version(db, dataset_id):
    return next(successful_versions(db, dataset_id), None)


def plan(db, composite_id):
    from .composite_series import period
    from .history_artifacts import chart_page
    from .live_window import require_window
    from .managed_rollover_coverage import history_coverage
    from .storage import Instrument

    composite = db.get(MarketComposite, composite_id)
    active, mapping_id = eligible(db, composite)
    previous = db.get(HistoryVersion, active.history_version_id)
    dataset = db.get(MarketDataset, composite.dataset_id)
    calendar = db.get(Instrument, dataset.instrument_id).calendar
    if calendar != active.rules.get("aggregation_calendar"):
        raise Deferred("维护日界与当前修订不同")
    reason = None
    for newest in successful_versions(db, composite.dataset_id):
        if newest.id == previous.id:
            break
        if (newest.end, newest.published_at or 0, newest.id) <= (
                previous.end, previous.published_at or 0, previous.id):
            continue
        try:
            if newest.start > previous.start or newest.end < previous.end:
                raise Deferred("新历史覆盖范围缩短，保留当前基线")
            tail = chart_page(db, newest.id, "M1", count=1)["bars"]
            if not tail:
                raise Deferred("新历史没有可读的 M1 数据")
            cutoff = (now_ms() - 5000) // 60000 * 60000
            seam = period(min(newest.end, tail[-1]["end"], cutoff), "D1", calendar)[0]
            if seam < active.seam or seam <= newest.start:
                raise Deferred("新历史尚不能提供不倒退的接续点")
            require_window(seam, now=now_ms())
            history_coverage(db, active, newest)
        except ValueError as error:
            reason = reason or str(error)
            continue
        return {"active_revision_id": active.id, "active_history_version_id": previous.id,
                "active_seam": active.seam, "version_id": newest.id,
                "dataset_id": dataset.id, "mapping_id": mapping_id, "seam": seam,
                "latest_available_version_id": newest.id,
                "request_id": "managed:" + key([composite.id, active.id, newest.id, mapping_id, seam])}
    if reason:
        raise Deferred(reason)
    return None


def lock_scope(db, composite, candidate=None):
    """Same source datasets -> composite -> preparations order as ingestion."""
    active = db.get(CompositeRevision, composite.active_revision_id)
    mapping = db.get(RealtimeMapping, active.mapping_id)
    datasets = {composite.dataset_id, mapping.target_dataset_id,
                db.get(HistoryVersion, active.history_version_id).dataset_id}
    if candidate:
        datasets.update((db.get(HistoryVersion, candidate.history_version_id).dataset_id,
                         db.get(RealtimeMapping, candidate.mapping_id).target_dataset_id))
    list(db.scalars(select(MarketDataset).where(MarketDataset.id.in_(
        sorted(datasets)))
        .order_by(MarketDataset.id).with_for_update()))
    return db.scalar(select(MarketComposite).where(MarketComposite.id == composite.id)
                     .with_for_update().execution_options(populate_existing=True))


def _candidate(composite_id):
    from .composite_revisions import create

    with transaction() as db:
        composite = lock_scope(db, db.get(MarketComposite, composite_id))
        selected = plan(db, composite_id)
        if selected is None:
            if status(db, composite_id).get("status") != "updated":
                _status(db, composite_id, "current")
            return None
        candidate = create(db, composite_id, {
            "request_id": selected["request_id"],
            "expected_revision_id": selected["active_revision_id"],
            "history_version_id": selected["version_id"], "mapping_id": selected["mapping_id"],
            "seam": selected["seam"], "reason": "维护完成后自动轮换历史基线",
        }, managed=True)
        run = db.scalar(select(MarketSwitchRun).where(
            MarketSwitchRun.kind == KIND, MarketSwitchRun.target_revision_id == candidate.id))
        if run is None:
            run = MarketSwitchRun(kind=KIND, composite_id=composite.id,
                previous_revision_id=selected["active_revision_id"],
                target_revision_id=candidate.id, scheduled_for=candidate.created_at,
                state="preparing")
            db.add(run)
            db.flush()
        _status(db, composite_id, "preparing", candidate_revision_id=candidate.id,
                history_version_id=selected["version_id"], run_id=run.id)
        return selected, candidate.id, run.id


def refresh_tail(db, candidate):
    """Catch a stale finite preparation up to the old confirmed tail.

    Ordinary live confirmation already fans out to every unfrozen candidate.
    Refresh the immutable activation input when that fanout advances it; a
    missing tail is explicitly queried rather than activated minutes behind.
    """
    ids = sorted({candidate.id, candidate.parent_revision_id})
    preps = {p.revision_id: p for p in db.scalars(select(CompositePreparation).where(
        CompositePreparation.revision_id.in_(ids)).order_by(CompositePreparation.revision_id)
        .with_for_update().execution_options(populate_existing=True))}
    prep, previous = preps[candidate.id], preps[candidate.parent_revision_id]
    if frozen(prep) or frozen(previous):
        raise Deferred("候选或父修订已冻结")
    required = max(candidate.seam, previous.confirmed_end)
    state = {**prep.state, "activation_watermark": required}
    effective_end = max(prep.confirmed_end, candidate.seam)
    if effective_end < required and prep.cursor < required and not prep.lease_token:
        # Original preparation cutoff is immutable audit evidence. A managed
        # candidate may add a separately recorded activation catch-up window.
        state["managed_tail_cutoff"] = max(prep.cutoff, required)
        prep.status, prep.next_at, prep.error = "pending", 0, None
    if (state.get("activation_input_revision") != prep.input_revision
            or effective_end < required):
        state.pop("activation_input_revision", None)
        state.pop("activation_indicators", None)
        state["activation_ready"] = False
    prep.state = state


def activation_gate(db, composite, candidate, progress):
    """Recheck inside activation's transaction; deferral never changes alerts."""
    if not settings.managed_rollover_enabled or not settings.switch_auto_activate_enabled:
        raise Deferred("自动基线轮换已关闭")
    selected = plan(db, composite.id)
    if not selected or selected["request_id"] != candidate.request_id:
        raise Deferred("候选已被最新历史、映射或活动修订取代")
    preps = {p.revision_id: p for p in db.scalars(select(CompositePreparation).where(
        CompositePreparation.revision_id.in_(sorted({candidate.id, candidate.parent_revision_id})))
        .order_by(CompositePreparation.revision_id).with_for_update()
        .execution_options(populate_existing=True))}
    prep, old = preps[candidate.id], preps[candidate.parent_revision_id]
    if (frozen(old) or frozen(prep) or max(prep.confirmed_end, candidate.seam) < old.confirmed_end
            or progress["input_revision"] != prep.input_revision):
        raise Deferred("候选正在追赶最新确认分钟")
    from .managed_rollover_coverage import prove

    try:
        prove(db, db.get(CompositeRevision, candidate.parent_revision_id), candidate, old, prep)
    except ValueError as error:
        raise Deferred(str(error)) from error
    # Geometry/indicator comparison is recomputed for the current alert versions,
    # not trusted from the earlier shadow snapshot.
    blocked = composite_alerts.automatic_blockers(db, composite, candidate, progress)
    if blocked:
        raise Deferred("；".join(item["reason"] for item in blocked)[:1000])


def reconcile(composite_id, *, adapter=None, budget=baseline_shadow.BUDGET):
    selected = None
    try:
        result = _candidate(composite_id)
        if result is None:
            return {"composite_id": composite_id, "status": "current"}
        selected, candidate_id, run_id = result
        # A real activation failure owns an explicit retry; never replay it here.
        with transaction() as db:
            attempted = db.scalar(select(MarketSwitchRun.id).where(
                MarketSwitchRun.kind == "revision_activation",
                MarketSwitchRun.target_revision_id == candidate_id).limit(1))
            if attempted:
                raise Deferred("基线激活已有执行记录，请查看记录后重试")
            refresh_tail(db, db.get(CompositeRevision, candidate_id))
        report = baseline_shadow.shadow(composite_id, run_id=run_id,
            adapter=adapter, budget=budget,
            plan_override={**selected, "candidate_revision_id": candidate_id})
        state = "ready" if report["ready"] else "preparing"
        reason = "；".join(item["detail"] for item in report["reasons"])
        with transaction() as db:
            composite = lock_scope(db, db.get(MarketComposite, composite_id))
            # Activation runs independently while shadow work performs I/O.
            # Its committed status owns the new head; stale work must not
            # replace "updated" with preparing/deferred after it has switched.
            if composite.active_revision_id != selected["active_revision_id"]:
                return {"composite_id": composite_id, "status": "current"}
            if report["ready"]:
                from .composite_revisions import readiness
                candidate = db.get(CompositeRevision, candidate_id)
                activation_gate(db, composite, candidate, readiness(db, candidate))
            _status(db, composite_id, state, reason or None,
                    candidate_revision_id=candidate_id, history_version_id=selected["version_id"], run_id=run_id)
        return {"composite_id": composite_id, "status": state}
    except (Deferred, ValueError) as error:
        with transaction() as db:
            composite = lock_scope(db, db.get(MarketComposite, composite_id))
            if selected and composite.active_revision_id != selected["active_revision_id"]:
                return {"composite_id": composite_id, "status": "current"}
            _status(db, composite_id, "deferred", str(error))
        return {"composite_id": composite_id, "status": "deferred", "reason": str(error)}


def cycle(*, adapter=None, budget=None):
    if not settings.managed_rollover_enabled:
        return {"worked": False, "composites": []}
    # Fair bounded scan; completed/disabled instruments cannot starve old ones.
    with transaction() as db:
        cursor = db.get(Preference, STATUS_PREFIX + "cursor")
        after = cursor.value.get("after", "") if cursor else ""
        ids = list(db.scalars(select(MarketComposite.id).where(
            MarketComposite.permission_scope == "workspace:default", MarketComposite.id > after)
            .order_by(MarketComposite.id).limit(BATCH_SIZE)))
        value = {"after": ids[-1] if len(ids) == BATCH_SIZE else ""}
        if cursor:
            cursor.value = value
        else:
            db.add(Preference(key=STATUS_PREFIX + "cursor", value=value))
    results = []
    for composite_id in ids:
        try:
            results.append(reconcile(composite_id, adapter=adapter,
                budget=baseline_shadow.BUDGET if budget is None else budget))
        except Exception as error:
            log.warning("Managed rollover failed composite=%s error_type=%s", composite_id, type(error).__name__)
            results.append({"composite_id": composite_id, "status": "error", "error": type(error).__name__})
    return {"worked": any(item["status"] == "ready" for item in results), "composites": results}
