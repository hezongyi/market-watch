"""Fixed composite rule inputs, complete dependency gates and safe recovery.

The alert owns a revision; neither daily history publication nor an active
chart's revision changes it. Evaluations use the same immutable period and
indicator readers as charts. A recovery establishes a new event baseline and
never replays missed/expired events as fresh notifications.
"""

import copy
from decimal import Decimal

from sqlalchemy import func, select

from . import switch_source
from .calendar_profile import closures_from
from .chart_alert_domain import Observation, line_value
from .composite_inputs import frozen
from .composite_series import period
from .config import settings
from .domain import calendar_from, scheduled_open
from .fixed_indicators import chart_results, digest, gap_before
from .history_catalog import account_scope
from .indicator_state import ALGORITHM
from .live_pricing import account_key
from .storage import (
    Audit,
    ChartAlert,
    ChartAlertVersion,
    CompositeAggregateTask,
    CompositeJudgment,
    CompositeMinuteInput,
    CompositePreparation,
    CompositeRevision,
    HistoryArtifact,
    HistoryVersion,
    Instrument,
    LiveState,
    MarketComposite,
    MarketDataset,
    PricingOwner,
    RealtimeMapping,
    instant,
    now_ms,
)

CONTRACT = "composite-alert-input-v1"
FROZEN_REASON = "组合已切换到新修订；旧修订输入已冻结，需显式改为新修订后恢复"


def identity(db, composite, revision, config):
    """The exact bound identity of one rule on one revision.

    Shared by rule creation and by the switch rebind, so a relocated rule keeps
    every other identity field byte-identical and only follows the revision.
    """
    version = db.get(HistoryVersion, revision.history_version_id)
    mapping = db.get(RealtimeMapping, revision.mapping_id)
    target = db.get(MarketDataset, mapping.target_dataset_id)
    inst = db.get(Instrument, composite.instrument_id)
    return {"instrument": composite.id, "instrument_id": inst.id, "series_kind": "composite",
        "source": "composite", "symbol": db.get(MarketDataset, version.dataset_id).logical_symbol,
        "basis": inst.basis, "calendar": revision.rules["aggregation_calendar"],
        "timeframe": config.timeframe, "precision": max(
            db.get(Instrument, db.get(MarketDataset, version.dataset_id).instrument_id).precision,
            db.get(Instrument, target.instrument_id).precision),
        "composite_id": composite.id, "composite_revision_id": revision.id,
        "history_version_id": version.id, "history_checksum": version.manifest["checksum"],
        "history_start": version.start, "dataset_id": version.dataset_id,
        "mapping_id": mapping.id, "target_dataset_id": target.id, "target_identity": target.identity,
        "seam": revision.seam, "rules": revision.rules, "seam_policy": config.seam_policy,
        "calculation_algorithm": ALGORITHM, "contract": CONTRACT,
        "initial_input_revision": db.get(CompositePreparation, revision.id).input_revision}


def bind(db, config, *, now=None):
    from .composite_definitions import first_use
    from .series_access import composite_definition

    dataset_id, mapping_id, composite = composite_definition(db, config.instrument)
    if not composite:
        if config.composite_revision_id:
            raise ValueError("组合尚未建立，不能指定不存在的修订")
        composite = first_use(db, dataset_id, mapping_id)
    revision = db.get(CompositeRevision, config.composite_revision_id or composite.active_revision_id)
    if not revision or revision.composite_id != composite.id:
        raise ValueError("组合修订不属于所选系列")
    version = db.get(HistoryVersion, revision.history_version_id)
    require_live_eligibility(db, revision, now=now_ms() if now is None else now,
                             timeframe=config.timeframe)
    mapping = db.get(RealtimeMapping, revision.mapping_id)
    target = db.get(MarketDataset, mapping.target_dataset_id)
    if target.identity["account_scope"] != account_scope():
        raise ValueError("实时映射不属于当前OANDA账户")
    if config.calculation_origin is not None and config.calculation_origin != version.start:
        raise ValueError("组合指标须从固定历史版本起点初始化")
    return identity(db, composite, revision, config)


def require_live_eligibility(db, revision, *, now, timeframe, lock=True):
    from .composite_quotes import live_snapshot
    from .realtime_switch import enabled, revision_instrument_id
    from .storage import CompositeAggregateTask, CompositePreparation, HistoryArtifact

    instrument_id = revision_instrument_id(db, revision)
    if not instrument_id:
        raise ValueError("组合固定历史来源不存在")
    if lock:
        from .chart_history_plan import lock_plan_instrument
        # Match evidence writers/evaluators before taking the instrument lock;
        # acquiring the historical dataset first can invert the pair's order.
        history = db.get(HistoryVersion, revision.history_version_id)
        mapping = db.get(RealtimeMapping, revision.mapping_id)
        list(db.scalars(select(MarketDataset.id).where(MarketDataset.id.in_(
            {history.dataset_id, mapping.target_dataset_id})).order_by(MarketDataset.id).with_for_update()))
        lock_plan_instrument(db, instrument_id)
    if not enabled(db, instrument_id):
        raise ValueError("该自建品种实时流已关闭，不能启动可执行告警")
    if not live_snapshot(db, revision, now=now)["sample_ready"]:
        raise ValueError("该组合实时来源尚未就绪，暂不能创建或恢复告警")
    prep = db.get(CompositePreparation, revision.id)
    task = db.get(CompositeAggregateTask, (revision.id, timeframe))
    artifact = db.scalar(select(HistoryArtifact.id).where(
        HistoryArtifact.version_id == revision.history_version_id,
        HistoryArtifact.timeframe == timeframe, HistoryArtifact.status == "published").limit(1))
    if (not prep or prep.status != "queried" or prep.error or not task or
            task.applied_input_revision < prep.input_revision or not artifact):
        raise ValueError("组合接缝或告警周期尚未准备就绪")


def bound_rules(db, composite_id, *, lock=False):
    """Active rules whose current version binds a revision of this composite."""
    query = select(ChartAlertVersion, ChartAlert).join(
        ChartAlert, (ChartAlertVersion.alert_id == ChartAlert.id) & (
            ChartAlertVersion.version == ChartAlert.version)).where(
                ChartAlert.status == "active",
                ChartAlertVersion.market_identity["composite_id"].as_string() == composite_id)
    if lock:
        query = query.with_for_update()
    return list(db.execute(query))


def pause(db, rules, *, reason, run_id=None, now=None):
    """Pause a rule that can no longer read a served revision; never migrate it."""
    now = now_ms() if now is None else now
    output = []
    for version, alert in rules:
        if alert.status != "active":
            continue
        alert.status, alert.control_revision = "paused", alert.control_revision + 1
        alert.health, alert.health_reason = "blocked", reason[:250]
        # The paused rule keeps holding its live target: the shared source stays
        # subscribed for an explicit resume. The existing held-rule demand only
        # recognises this value, so the switch reason is carried alongside it.
        alert.runtime = {**alert.runtime, "demand_hold": "stale_input",
                         "switch_reason": reason}
        alert.updated_at = now
        revision_id = version.market_identity.get("composite_revision_id")
        db.add(Audit(kind="chart_alert_paused", details={"alert_id": alert.id,
            "revision_id": revision_id, "reason": reason, "run_id": run_id}))
        output.append({"id": alert.id, "revision_id": revision_id})
    return output


def pause_bound(db, composite_id, *, reason, run_id=None, now=None):
    """Safe pause: no active rule keeps reading a revision that cannot serve it."""
    rules = bound_rules(db, composite_id, lock=True)
    return {"paused": pause(db, rules, reason=reason, run_id=run_id, now=now),
            "bound": len(rules)}


SHAPE_KEYS = ("aggregation", "selection", "tail_revisions")


def relocatable(db, previous, target, config, bound, *, input_revision, source=None):
    """Can this rule move onto the target revision without changing its shape?

    Only a same-service-shape revision may take over a running rule: the same
    aggregation calendar, the same stitching rules and seam policy, and the same
    live price basis and precision. A calendar or price-basis change moves bucket
    boundaries and price semantics, so the rule is paused explicitly instead of
    being moved onto a different shape. The last checks are the period artifact
    and the aggregate waterline the rule needs to read that revision at all.
    """
    served = (previous.rules.get("aggregation_calendar"),
              target.rules.get("aggregation_calendar"))
    if served[0] != served[1]:
        return False, f"目标修订服务日历 {served[1]}，与规则绑定的 {served[0]} 不兼容"
    for key in SHAPE_KEYS:
        if previous.rules.get(key) != target.rules.get(key):
            return False, f"目标修订的 {key} 规则与规则绑定修订不一致"
    if bound.get("seam_policy") != config.seam_policy:
        return False, "规则接缝策略与其固定身份不一致"
    if source is not None and not source.get("compatible"):
        return False, "候选来源能力闸门未通过"
    before, after = switch_source.capabilities(db, previous), switch_source.capabilities(db, target)
    if (before.basis, before.precision) != (after.basis, after.precision):
        return False, (f"目标修订价格口径 {after.basis}/{after.precision} 位，"
                       f"与规则绑定的 {before.basis}/{before.precision} 位不一致")
    artifact = db.scalar(select(HistoryArtifact.id).where(
        HistoryArtifact.version_id == target.history_version_id,
        HistoryArtifact.timeframe == config.timeframe,
        HistoryArtifact.status == "published").limit(1))
    if not artifact:
        return False, f"目标修订缺少 {config.timeframe} 固定周期产物"
    task = db.get(CompositeAggregateTask, (target.id, config.timeframe))
    if not task or task.applied_input_revision < input_revision:
        return False, f"目标修订 {config.timeframe} 聚合水位未覆盖激活输入"
    return True, None


def rebind_active(db, composite, *, previous, target, boundary, run_id, now, input_revision,
                  source=None, shadow=None):
    """Move every active rule onto the activated revision at one event boundary.

    A rule that the target revision can serve is relocated by a new immutable
    version: same condition, geometry, limits and delivery choice, only the bound
    revision changes. Its judgment baseline restarts at the boundary, so no
    pre-switch value replays as a fresh crossing. A rule the target cannot serve
    yet is paused with a concrete reason instead of silently kept on frozen input.

    The shadow mapping carries the candidate's own shadow report: a rule it already
    marks as will_pause (missing indicator, incompatible source, geometry that
    cannot be relocated) was never allowed to move, because a shifted drawing or a
    rebuilt ATR reference is a different rule. Both judgements are a union: either
    one can only pause, never relocate.
    """
    from .chart_alert_service import AlertConfig

    aligned, rebound, paused, affected = [], [], [], []
    for version, alert in bound_rules(db, composite.id, lock=True):
        config = AlertConfig.model_validate(version.config)
        current = version.market_identity.get("composite_revision_id")
        if current == target.id:
            aligned.append({"id": alert.id, "revision_id": target.id, "version": alert.version})
            affected.append({"id": alert.id, "name": alert.name, "revision_id": current,
                             "migration": "aligned_on_target"})
        elif (shadow or {}).get(alert.id):
            # The candidate's shadow report already proved this rule cannot move.
            reason = shadow[alert.id]
            paused.extend(pause(db, [(version, alert)],
                reason="组合修订切换后该规则暂不可迁移：" + reason, run_id=run_id, now=now))
            affected.append({"id": alert.id, "name": alert.name, "revision_id": current,
                             "migration": "paused_shadow_rule", "reason": reason})
            continue
        else:
            ready, reason = relocatable(db, previous, target, config,
                version.market_identity, input_revision=input_revision, source=source)
            if not ready:
                paused.extend(pause(db, [(version, alert)],
                    reason="组合修订切换后该规则暂不可迁移：" + reason, run_id=run_id, now=now))
                affected.append({"id": alert.id, "name": alert.name, "revision_id": current,
                                 "migration": "paused_target_not_ready", "reason": reason})
                continue
            db.add(ChartAlertVersion(alert_id=alert.id, version=alert.version + 1,
                config={**version.config, "composite_revision_id": target.id},
                market_identity=identity(db, composite, target, config),
                dataset_id=version.dataset_id, effective_at=boundary))
            db.add(Audit(kind="chart_alert_rebound", details={"alert_id": alert.id,
                "run_id": run_id, "previous_revision_id": current, "revision_id": target.id,
                "from_version": alert.version, "to_version": alert.version + 1,
                "boundary": boundary}))
            rebound.append({"id": alert.id, "revision_id": target.id,
                            "version": alert.version + 1, "previous_revision_id": current})
            affected.append({"id": alert.id, "name": alert.name, "revision_id": target.id,
                             "previous_revision_id": current,
                             "migration": "relocated_to_activated_revision"})
            alert.version = alert.version + 1
        # Both relocated and already-aligned rules start a new judgment baseline.
        alert.state = {}
        alert.runtime = {**alert.runtime, "switch_run_id": run_id, "switch_boundary": boundary}
        alert.effective_at = boundary
        alert.control_revision += 1
        alert.health, alert.health_reason = "warming", "组合修订切换后建立新判定基准"
        alert.updated_at = now
    return {"aligned": aligned, "rebound": rebound, "paused": paused, "affected": affected,
            "boundary": boundary}


def geometry_rows(db, composite_id, frame, points, *, revision_id=None, input_revision=None, now=None):
    from .chart_query import DataQuery
    from .series_access import chart_data

    cutoff, output = None, []
    endpoint = min(point.time for point in points)
    for _ in range(32):
        page = chart_data(db, DataQuery(instrument=composite_id, series_kind="composite", timeframe=frame,
            composite_revision_id=revision_id, input_revision=input_revision, limit=2000, before=cutoff,
            provisional=False))
        if page["pending"]:
            raise ValueError("画线所需的固定周期尚未发布")
        revision_id, input_revision = page["revision_id"], page["input_revision"]
        output = page["bars"] + output
        cutoff = page["next_before"]
        if cutoff is None or output and output[0].get("chart_time", output[0]["start"]) <= endpoint:
            return output, {"calendar": page["calendar"], "calendar_profile": {}}
    raise ValueError("画线端点超过本次64000根固定周期查询范围，请缩短范围")


def wait(alert, runtime, status, reason, *, reset=True):
    if reset:
        runtime["recovering"] = True
    runtime["readiness"] = {"ready": False, "reason": reason, "status": status}
    alert.runtime = runtime
    alert.health, alert.health_reason = status, reason
    return []


def confirmed_window(db, revision, start, end, value, phase, profiles):
    """Validate every prior M1 dependency in an open high-period bucket."""
    from .composite_inputs import rows as minute_rows
    from .history_artifacts import read_artifact

    cursor = start
    while cursor < min(end, revision.seam):
        rows = read_artifact(db, revision.history_version_id, "M1", start=cursor,
                            end=min(end, revision.seam), limit=20000)
        if not rows:
            break
        for row in rows:
            if not row["complete"] or gap_before(cursor, row["start"], phase, profiles):
                return False
            cursor = row["end"]
        if len(rows) < 20000:
            break
    if cursor < end and end > revision.seam:
        for minute in minute_rows(db, revision.id, max(cursor, revision.seam), end, input_revision=value):
            if not minute["complete"] or gap_before(cursor, minute["timestamp"], phase, profiles):
                return False
            cursor = minute["timestamp"] + 60000
    return not gap_before(cursor, end, phase, profiles)


def operands(db, page, config, now):
    """Return indexed values and complete dependency manifests, no vector truncation."""
    specs = [indicator.model_dump(exclude={"output"}) for indicator in config.indicators()]
    results, progress = chart_results(db, page, specs, provisional=config.mode == "intrabar", stamp=now, purpose='alert')
    prepared = {digest({key: result[key] for key in ("name", "version", "params")}): result for result in results}
    bar = page["bars"][-1]
    values, dependencies = [], []
    for operand in (config.condition.left, config.condition.right):
        if operand is None:
            values.append(None)
        elif operand.kind == "constant":
            values.append(operand.value)
        elif operand.kind == "price":
            values.append(Decimal(str(bar["close"])))
            dependencies.append({"kind": "price", "start": bar["start"], "end": bar["end"],
                "coverage_complete": bar["coverage_complete"], "source_confirmed": bar["source_confirmed"],
                "seam_dependency": bar.get("seam_crossing", False),
                **({"price_confirmation": bar["price_confirmation"]} if bar.get("price_confirmation") else {})})
        elif operand.kind == "indicator":
            spec = operand.indicator.model_dump(exclude={"output"})
            result = prepared[digest(spec)]
            output = next(item for item in result["series"] if item["key"] == operand.indicator.output)
            point = next((row for row in output["values"] if row["time"] == bar["start"]), None)
            values.append(Decimal(str(point["value"])) if point and point["value"] is not None else None)
            dependency = next((row for row in result["dependencies"] if row["start"] == bar["start"]), None)
            dependencies.append({"kind": "indicator", "spec": spec, "output": operand.indicator.output,
                "calculation": result["calculation"], "dependency": dependency,
                "seam_dependency": bool(dependency and dependency["seam_dependency"])})
        else:
            from .chart_alert_worker import geometry_indices

            meta = {"calendar": page["calendar"], "calendar_profile": {}}
            line_rows = page["bars"]
            if operand.line.kind != "horizontal_line":
                line_rows, meta = geometry_rows(db, page["composite_id"], config.timeframe, operand.line.points,
                    revision_id=page["revision_id"], input_revision=page["input_revision"], now=now)
            indices = geometry_indices(line_rows, operand.line, meta=meta, config=config)
            values.append(line_value(operand.line, indices[-1]))
            dependencies.append({"kind": "line", "geometry": operand.line.model_dump(mode="json"),
                                 "index": indices[-1]})
    return values, dependencies, progress


def atr_offset(db, identity, config, bar, value, now, profiles, runtime):
    """The ATR reader owns the same immutable revision/input as the main page."""
    from .chart_alert_offsets import OffsetComputing, OffsetPending, reference_bar, resolve
    from .composite_chart import chart_page
    from .storage import CompositePreparation

    spec = config.condition.offset
    task = db.get(CompositeAggregateTask, (identity["composite_revision_id"], spec.timeframe))
    if not task or task.applied_input_revision < value:
        raise OffsetPending("ATR 周期聚合水位尚未处理完整固定输入")
    meta = {"calendar": identity["calendar"], "calendar_profile": profiles[-1][2], "series_kind": "composite"}
    start, end = reference_bar(bar["start"], spec.timeframe, meta, config.instrument)
    page = chart_page(db, identity["composite_id"], spec.timeframe,
        revision_id=identity["composite_revision_id"], input_revision=value,
        provisional=False, count=2, before=end, now=now)
    reference = next((row for row in page["bars"] if row["start"] == start and row["end"] == end), None)
    if page["pending"] or not reference:
        raise OffsetPending("最近预期 ATR 柱缺失，等待固定输入完整发布")
    page["bars"] = [reference]
    results, progress = chart_results(db, page, [spec.spec()], provisional=False, stamp=now)
    runtime["offset_indicators"] = progress
    # The offset joins the preceding completed bar. Its immutable, validated
    # prefix can already cover that reference while a newer, unused suffix is
    # pending. Do not wait for the whole target or call that suffix complete.
    if not progress or any(item["cursor"] < end for item in progress):
        raise OffsetComputing("ATR 固定起点初始化或修订修复尚未完成")
    result = results[0]
    point = next((row for row in result["series"][0]["values"] if row["time"] == start), None)
    dependency = next((row for row in result["dependencies"] if row["start"] == start), None)
    if not dependency or not dependency.get("initialized"):
        raise OffsetPending("ATR 来源确认或覆盖依赖不完整")
    if dependency.get("seam_dependency") and config.seam_policy == "reject":
        raise OffsetPending("ATR 依赖包含原价接缝；需明确接受接缝影响")
    from .composite_inputs import confirmation_watermark

    origin = dependency["dependency_origin"]
    key = [identity["composite_revision_id"], value, origin, end]
    cached = runtime.get("atr_confirmation", {})
    watermark = cached.get("watermark") if cached.get("key") == key else None
    if watermark is None:
        watermark = confirmation_watermark(db, identity["composite_revision_id"], origin, end, value,
                                           previous=cached if cached.get("key") else None)
        runtime["atr_confirmation"] = {"key": key, "watermark": watermark}
    resolved = resolve(spec, config.condition.relation, bar, reference,
        point["value"] if point else None, dependency={**identity["atr_dependency"],
            "composite_revision_id": identity["composite_revision_id"], "input_revision": value,
            "history_version_id": identity["history_version_id"],
            "calculation": result["calculation"], "dependency": dependency})
    resolved["available_at"] = now
    resolved["confirmation_watermark"] = watermark
    resolved["confirmed_end"] = db.get(CompositePreparation, identity["composite_revision_id"]).confirmed_end
    return resolved


def evaluate(db, alert, version, config, now, *, clock=None):
    from .chart_alert_service import consume
    from .composite_chart import chart_page

    identity = version.market_identity
    runtime = dict(alert.runtime)
    runtime.pop("price_confirmation_request", None)
    if identity.get("contract") != CONTRACT or identity.get("calculation_algorithm") != ALGORITHM:
        return wait(alert, runtime, "blocked", "组合或指标算法契约已改变，请显式编辑规则生成新版本")
    revision = db.get(CompositeRevision, identity["composite_revision_id"])
    composite = db.get(MarketComposite, identity["composite_id"])
    if revision and frozen(db.get(CompositePreparation, revision.id)):
        # Fencing: a judgment round for a switched-away revision writes nothing.
        return wait(alert, runtime, "blocked", FROZEN_REASON)
    mapping = db.get(RealtimeMapping, revision.mapping_id) if revision else None
    target = db.get(MarketDataset, mapping.target_dataset_id) if mapping else None
    if (not composite or composite.permission_scope != "workspace:default" or not revision or
            revision.composite_id != composite.id or revision.history_version_id != identity["history_version_id"] or
            revision.rules != identity["rules"] or revision.seam != identity["seam"] or
            not target or target.identity != identity["target_identity"] or target.identity["account_scope"] != account_scope()):
        return wait(alert, runtime, "blocked", "固定组合基线、映射或账户已改变，请显式编辑规则")
    # Evidence writers/reference protection take exclusive dataset locks. Take
    # them in order before shared artifact reads, avoiding reader lock upgrades.
    list(db.scalars(select(MarketDataset.id).where(MarketDataset.id.in_(
        sorted({identity["dataset_id"], target.id}))).order_by(MarketDataset.id).with_for_update()))
    # Source writers take these dataset locks before LiveState. Capture the
    # production clock after lock acquisition, so a source commit while we
    # waited cannot look like future input and reset a valid crossing baseline.
    # Explicit historical/test clocks stay fixed; no age is clamped to zero.
    if clock is not None:
        now = clock()
    from .live_window import lower_bound

    if revision.seam < lower_bound(now):
        alert.status, alert.control_revision = "paused", alert.control_revision + 1
        return wait(alert, runtime, "blocked", "实时基线超出30天可用窗口，等待更新历史基线")
    from .realtime_switch import enabled

    source_dataset = db.get(MarketDataset, identity["dataset_id"])
    if not enabled(db, source_dataset.instrument_id):
        alert.status, alert.control_revision = "paused", alert.control_revision + 1
        alert.health, alert.health_reason = "blocked", "自建品种实时流已关闭；告警已暂停，启用后需明确恢复"
        alert.updated_at = now
        return []
    from .composite_quotes import (
        json_safe,
        live_snapshot,
        observation_evidence,
        sampled_observation,
    )

    live_view = live_snapshot(db, revision, now=now)
    runtime["quote_health"] = "ready" if live_view.get("sample_ready") else "stale"
    runtime["observation_mode"] = live_view.get("observation_mode", "stream_quote")
    prep = db.get(CompositePreparation, revision.id)
    value = prep.input_revision
    runtime.update(composite_revision_id=revision.id, input_revision=value,
                   history_version_id=identity["history_version_id"], seam_policy=config.seam_policy)
    phase = revision.rules["aggregation_calendar"]
    target_inst = db.get(Instrument, target.instrument_id)
    profile = target_inst.calendar_profile
    profiles = [(identity["history_start"], revision.seam,
                 db.get(HistoryVersion, revision.history_version_id).manifest.get("calendar_profile", {})),
                (revision.seam, now + 1, profile)]
    from .live_session import session_status

    is_open = session_status(target.identity, profile, now)['market_session'] != 'closed' and scheduled_open(
        instant(now), calendar_from(phase, profile, explicit=True), closures=closures_from(profile))
    stale_input = live_view.get("received_age_ms") is None or live_view["received_age_ms"] > 15000
    if live_view["observation_mode"] == "stream_quote":
        stale_input = stale_input or live_view.get("quote_age_ms") is None or live_view["quote_age_ms"] > 15000
    if is_open and stale_input:
        runtime["demand_hold"] = "stale_input"
        alert.status, alert.control_revision = "paused", alert.control_revision + 1
        alert.health, alert.health_reason = "blocked", "组合实时输入已过期；告警已暂停，恢复后需明确重启"
        alert.updated_at = now
        return wait(alert, runtime, "blocked", alert.health_reason)
    if prep.status != "queried" or prep.error:
        return wait(alert, runtime, "warming", "确认M1接续准备或恢复尚未完成")
    task = db.get(CompositeAggregateTask, (revision.id, config.timeframe))
    if not task or task.applied_input_revision < value:
        return wait(alert, runtime, "warming", "所需周期尚未处理完整固定输入；等待聚合水位", reset=False)
    live = db.get(LiveState, target.id)
    owner = db.get(PricingOwner, account_key(settings.oanda_account_id))
    owned = bool(owner and owner.error not in ('unauthorized', 'provider_maintenance')
        and owner.token and owner.expires > now and live and live.epoch == owner.epoch
        and live.connection in ("connected", "recovering") and 0 <= now - max(live.heartbeat_at, live.received_at) <= 15000)
    if is_open and (not owned or not live.ready or live.error):
        return wait(alert, runtime, "stale", "确认来源断线、拥有者过期或恢复未就绪；等待补齐后建立新基准")
    if not is_open:
        alert.health, alert.health_reason = "ready" if alert.state else "warming", "已证实闭市，等待下一时段新样本"
        runtime["closed"] = True
        alert.runtime = runtime
        return []
    page = chart_page(db, composite.id, config.timeframe, revision_id=revision.id,
        input_revision=None if config.mode == "intrabar" else value, provisional=config.mode == "intrabar",
        count=2000, now=now)
    page["calendar"] = phase
    if config.mode == "close":
        page["bars"] = [row for row in page["bars"] if row["end"] <= now]
    if page["pending"] or not page["bars"]:
        return wait(alert, runtime, "warming", "等待固定历史周期及首个有效确认观察")
    # Drawing labels must match the public chart's NY17/UTC display mapping.
    from .series_access import fixed_label

    for row in page["bars"]:
        row["chart_time"] = fixed_label(row, config.timeframe, phase)
    bar = page["bars"][-1]
    if bar["start"] < revision.seam:
        return wait(alert, runtime, "warming", "只有固定历史可读，尚无接续来源确认输入")
    if config.mode == "close" and not bar["coverage_complete"]:
        from .composite_price_confirmation import confirmation, eligible

        if eligible(config, revision, bar):
            proof = confirmation(db, target.identity, phase, bar, runtime)
            if proof:
                # Keep fixed bars and minute coverage intact. Only this rule's
                # OHLC dependency gains the independently matched source proof.
                bar = dict(bar, price_confirmation=proof)
                page["bars"][-1] = bar
    if config.mode == "close" and not (bar["time_closed"] and bar["source_confirmed"]
            and (bar["coverage_complete"] or bar.get("price_confirmation"))):
        from datetime import datetime, timezone

        def label(stamp):
            return datetime.fromtimestamp(stamp / 1000, timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        runtime["coverage_dependency"] = {key: bar.get(key) for key in (
            "start", "end", "time_closed", "source_confirmed", "coverage_complete", "observed_minutes", "unknown_minutes")}
        reason = (f"判定柱 {label(bar['start'])} 至 {label(bar['end'])}："
                  f"观测 {bar.get('observed_minutes', 0)} 分钟，未知 {bar.get('unknown_minutes', 0)} 分钟；"
                  "时间结束、来源确认或覆盖依赖未满足；缺失观测不作为闭市证据")
        # A transport outage leaves the strategy in recovery mode.  Keep that
        # state stale until an explicit source observation closes the gap;
        # ``coverage_pending`` is reserved for a healthy source with a known
        # sparse/unknown coverage dependency (for example native D1 proof).
        status = "stale" if alert.health == "stale" and runtime.get("recovering") else "coverage_pending"
        return wait(alert, runtime, status, reason, reset=False)
    runtime.pop("coverage_dependency", None)
    runtime.pop("price_confirmation_request", None)
    if config.mode == "close" and live.confirmed_end < bar["end"]:
        return wait(alert, runtime, "stale", "实时来源确认水位尚未覆盖判定柱")
    quote = live.quote if live else {}
    live_sample = sampled_observation(live_view)
    if config.mode == "intrabar":
        if not owned or live_sample is None:
            return wait(alert, runtime, "stale", "当前价格采样过期或来源未就绪；不重建未观测触价")
        if (not live.forming or period(live.forming["start"], config.timeframe, phase)[0] != bar["start"]
                or bar["source_confirmed"] or live_sample["source_start"] < revision.seam):
            return wait(alert, runtime, "warming", "等待有效临时桶与当前价格采样对齐")
        # Unknown current M1 is expected for provisional observation; any earlier
        # unknown minute in that bucket still fences the strategy.
        closed_end = live.forming["start"]
        if not confirmed_window(db, revision, max(identity["history_start"], bar["start"]), closed_end,
                                value, phase, profiles):
            return wait(alert, runtime, "coverage_pending", "临时桶之前仍有未确认分钟，完整依赖未恢复")
    expected = period(max(0, now - 30000), config.timeframe, phase)[0]
    if config.mode == "close" and bar["end"] < expected:
        return wait(alert, runtime, "stale", "判定周期尚无新鲜完整收盘；旧输入不补发事件")
    try:
        values, dependencies, progress = operands(db, page, config, now)
    except ValueError as error:
        return wait(alert, runtime, "blocked", str(error))
    runtime["indicators"] = progress
    if config.mode == "intrabar":
        for index, operand in enumerate((config.condition.left, config.condition.right)):
            if operand and operand.kind == "price":
                values[index] = live_sample["value"]
    if any(item["status"] != "complete" and not item.get("provisional_ready")
           for item in progress):
        return wait(alert, runtime, "warming", "指标完整初始化或修订修复尚未完成", reset=False)
    if values[0] is None or config.condition.right and values[1] is None:
        return wait(alert, runtime, "warming", "完整有效依赖尚不足以初始化指标或画线观察")
    if config.seam_policy == "reject" and any(item.get("seam_dependency") for item in dependencies):
        return wait(alert, runtime, "blocked", "指标依赖包含原价接缝；需明确接受接缝影响或等待完整同源窗口")
    resolved = None
    if config.condition.offset:
        from .chart_alert_offsets import OffsetComputing, OffsetPending, apply
        try:
            resolved = atr_offset(db, identity, config, bar, value, now, profiles, runtime)
            observation_at = bar["end"] if config.mode == "close" else live_sample["sequence"]
            if resolved["confirmation_watermark"] > observation_at:
                raise OffsetPending("ATR 递归输入确认晚于观察时点，等待安全恢复基准")
            values[1] = apply(values[1], resolved)
            dependencies.append({"kind": "atr_offset", **resolved})
        except OffsetPending as exc:
            return wait(alert, runtime, "warming", str(exc), reset=not isinstance(exc, OffsetComputing))
    previous = page["bars"][-2] if len(page["bars"]) > 1 else None
    sequence = bar["end"] if config.mode == "close" else live_sample["sequence"]
    old_end = runtime.get("confirmed_end", 0)
    previous_input = runtime.get("processed_input_revision", value)
    correction_end = max(old_end, runtime.get("offset", {}).get("reference_end", 0))
    earliest = db.scalar(select(func.min(CompositeMinuteInput.start)).where(
        CompositeMinuteInput.revision_id == revision.id,
        CompositeMinuteInput.input_revision > previous_input, CompositeMinuteInput.input_revision <= value,
        CompositeMinuteInput.start < correction_end)) if value > previous_input else None
    correction = earliest is not None
    prior_sequence = alert.state.get("sequence")
    observation_gap = sequence - prior_sequence if config.mode == "intrabar" and prior_sequence is not None else None
    recovering = bool(runtime.get("recovering") or runtime.pop("closed", False) or
                      runtime.get("epoch", live.epoch) != live.epoch or correction or
                      observation_gap is not None and observation_gap > 15000)
    crossed_seam = bool((bar.get("seam_crossing") or bar.get("seam_at_start")) and
                        runtime.get("last_start") != bar["start"] or
                        runtime.get("last_start", bar["start"]) < revision.seam <= bar["start"])
    has_gap = bool(previous and gap_before(previous["end"], bar["start"], phase, profiles))
    missed = config.mode == "close" and alert.state and previous and alert.state.get("sequence") != previous["end"]
    late = now - sequence > 120000
    baseline = recovering or crossed_seam or has_gap or missed or late or sequence <= alert.effective_at or not alert.state
    if alert.state.get("sequence", -1) == sequence and not recovering:
        runtime["processed_input_revision"] = value
        runtime["readiness"] = {"ready": True, "status": "ready", "dependencies": dependencies}
        alert.runtime = runtime
        alert.health, alert.health_reason = "ready", None
        return []
    if sequence < alert.state.get("sequence", -1):
        return wait(alert, runtime, "stale", "收到旧时间观察；不回退判断水位或重建未观测事件")
    before_state = copy.deepcopy(alert.state)
    if baseline:
        alert.state = {}  # Repaired/recovered same-time values establish a new baseline.
    outcome = "recovery_baseline" if recovering else "seam_baseline" if crossed_seam else (
        "gap_baseline" if has_gap or missed else "expired_baseline" if late else "initial_baseline" if baseline else "evaluated")
    evidence = {"contract": CONTRACT, "bar": bar, "input_manifest": {
        "history_version_id": identity["history_version_id"], "history_checksum": identity["history_checksum"],
        "composite_revision_id": revision.id, "input_revision": value, "mapping_id": revision.mapping_id,
        "rules": revision.rules, "seam": revision.seam}, "dependencies": dependencies,
        "seam_policy": config.seam_policy, "previous_state": before_state, "recovery": recovering,
        "correction_from": earliest, "baseline_reason": outcome if baseline else None,
        "observation_gap_ms": observation_gap,
        "source_epoch": live.epoch, "quote": dict(quote) if config.mode == "intrabar" and live_sample["kind"] == "sampled_bid" else None,
        "sample": observation_evidence(live_sample) if config.mode == "intrabar" else None,
        "observation_basis": ("native_confirmed_close" if bar.get("price_confirmation") else "complete_close")
            if config.mode == "close" else ("sampled_bid_quote" if live_sample["kind"] == "sampled_bid"
                                              else "sampled_candle_close")}
    if resolved:
        evidence["offset"] = resolved
    sample = Observation(f"bar:{bar['start']}" if config.mode == "close" else f"sample:{sequence}",
        sequence, sequence, values[0], values[1],
        live_sample["value"] if config.mode == "intrabar" else Decimal(str(bar["close"])), evidence)
    alert.runtime = runtime
    signal = consume(db, alert.id, sample, detected_at=now, baseline=baseline, expected_version=alert.version)
    runtime = dict(alert.runtime)
    judgment_id = digest([version.id, alert.run, revision.id, value, sequence, live.epoch, outcome])
    if not db.get(CompositeJudgment, judgment_id):
        db.add(CompositeJudgment(id=judgment_id, alert_version_id=version.id, revision_id=revision.id,
            history_version_id=identity["history_version_id"], input_revision=value, event_time=sequence,
            outcome="triggered" if signal else outcome, signal_id=signal.id if signal else None,
            evidence=json_safe({**evidence, "left": str(values[0]), "right": str(values[1]) if values[1] is not None else None,
                      "rule_version": alert.version, "rule": version.config})))
    runtime.update(processed_input_revision=value, confirmed_end=bar["end"] if config.mode == "close" else
        max(runtime.get("confirmed_end", 0), previous["end"] if previous and previous["source_confirmed"] else 0),
        epoch=live.epoch, recovering=False, last_start=bar["start"],
        readiness={"ready": True, "status": "ready", "dependencies": dependencies, "last_outcome": outcome})
    alert.runtime = runtime
    alert.health, alert.health_reason = "ready", "恢复/接缝后已建立新基准，等待新事件" if baseline else None
    return [signal.id] if signal else []
