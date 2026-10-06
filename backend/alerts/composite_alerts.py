"""Fixed composite rule inputs, complete dependency gates and safe recovery.

The alert owns a revision; neither daily history publication nor an active
chart's revision changes it. Evaluations use the same immutable period and
indicator readers as charts. A recovery establishes a new event baseline and
never replays missed/expired events as fresh notifications.
"""

import copy
from decimal import Decimal

from sqlalchemy import func, select

from .calendar_profile import closures_from
from .chart_alert_domain import Observation, line_value
from .composite_series import period
from .config import settings
from .domain import calendar_from, scheduled_open
from .fixed_indicators import chart_results, digest, gap_before
from .history_catalog import account_scope
from .indicator_state import ALGORITHM
from .live_pricing import account_key
from .storage import (
    CompositeAggregateTask,
    CompositeJudgment,
    CompositeMinuteInput,
    CompositePreparation,
    CompositeRevision,
    HistoryVersion,
    Instrument,
    LiveState,
    MarketComposite,
    MarketDataset,
    PricingOwner,
    RealtimeMapping,
    instant,
)

CONTRACT = "composite-alert-input-v1"


def bind(db, config):
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
    mapping = db.get(RealtimeMapping, revision.mapping_id)
    target = db.get(MarketDataset, mapping.target_dataset_id)
    if target.identity["account_scope"] != account_scope():
        raise ValueError("实时映射不属于当前OANDA账户")
    if config.calculation_origin is not None and config.calculation_origin != version.start:
        raise ValueError("组合指标须从固定历史版本起点初始化")
    inst = db.get(Instrument, composite.instrument_id)
    return {"instrument": composite.id, "instrument_id": inst.id, "series_kind": "composite",
        "source": "composite", "symbol": db.get(MarketDataset, composite.dataset_id).logical_symbol,
        "basis": inst.basis, "calendar": revision.rules["aggregation_calendar"],
        "timeframe": config.timeframe, "precision": inst.precision,
        "composite_id": composite.id, "composite_revision_id": revision.id,
        "history_version_id": version.id, "history_checksum": version.manifest["checksum"],
        "history_start": version.start, "dataset_id": composite.dataset_id,
        "mapping_id": mapping.id, "target_dataset_id": target.id, "target_identity": target.identity,
        "seam": revision.seam, "rules": revision.rules, "seam_policy": config.seam_policy,
        "calculation_algorithm": ALGORITHM, "contract": CONTRACT,
        "initial_input_revision": db.get(CompositePreparation, revision.id).input_revision}


def geometry_rows(db, composite_id, frame, points, *, revision_id=None, input_revision=None, now=None):
    from .chart_api import DataQuery
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
    results, progress = chart_results(db, page, specs, provisional=config.mode == "intrabar", stamp=now)
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
                "seam_dependency": bar.get("seam_crossing", False)})
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


def evaluate(db, alert, version, config, now):
    from .chart_alert_service import consume
    from .composite_chart import chart_page

    identity = version.market_identity
    runtime = dict(alert.runtime)
    if identity.get("contract") != CONTRACT or identity.get("calculation_algorithm") != ALGORITHM:
        return wait(alert, runtime, "blocked", "组合或指标算法契约已改变，请显式编辑规则生成新版本")
    revision = db.get(CompositeRevision, identity["composite_revision_id"])
    composite = db.get(MarketComposite, identity["composite_id"])
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
        sorted({composite.dataset_id, target.id}))).order_by(MarketDataset.id).with_for_update()))
    prep = db.get(CompositePreparation, revision.id)
    value = prep.input_revision
    runtime.update(composite_revision_id=revision.id, input_revision=value,
                   history_version_id=identity["history_version_id"], seam_policy=config.seam_policy)
    if prep.status != "queried" or prep.error:
        return wait(alert, runtime, "warming", "确认M1接续准备或恢复尚未完成")
    task = db.get(CompositeAggregateTask, (revision.id, config.timeframe))
    if not task or task.applied_input_revision < value:
        return wait(alert, runtime, "warming", "所需周期尚未处理完整固定输入；等待聚合水位", reset=False)
    phase = revision.rules["aggregation_calendar"]
    target_inst = db.get(Instrument, target.instrument_id)
    profile = target_inst.calendar_profile
    profiles = [(identity["history_start"], revision.seam,
                 db.get(HistoryVersion, revision.history_version_id).manifest.get("calendar_profile", {})),
                (revision.seam, now + 1, profile)]
    is_open = scheduled_open(instant(now), calendar_from(phase, profile, explicit=True), closures=closures_from(profile))
    live = db.get(LiveState, target.id)
    owner = db.get(PricingOwner, account_key(settings.oanda_account_id))
    owned = bool(owner and owner.token and owner.expires > now and live and live.epoch == owner.epoch
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
    if config.mode == "close" and not (bar["time_closed"] and bar["source_confirmed"] and bar["coverage_complete"]):
        return wait(alert, runtime, "stale", "判定柱的时间结束、来源确认或覆盖依赖不完整")
    if config.mode == "close" and live.confirmed_end < bar["end"]:
        return wait(alert, runtime, "stale", "实时来源确认水位尚未覆盖判定柱")
    quote = live.quote if live else {}
    if config.mode == "intrabar":
        if (not owned or not quote.get("tradeable") or quote.get("bid") is None or quote.get("ask") is None or
                Decimal(quote["ask"]) < Decimal(quote["bid"]) or
                not 0 <= now - quote.get("source_time", 0) <= 15000 or not 0 <= now - live.received_at <= 15000):
            return wait(alert, runtime, "stale", "抽样报价过期、不可交易或价差无效；不重建未观测触价")
        if not live.forming or period(live.forming["start"], config.timeframe, phase)[0] != bar["start"] or bar["source_confirmed"]:
            return wait(alert, runtime, "warming", "等待有效临时桶与报价对齐")
        # Unknown current M1 is expected for provisional observation; any earlier
        # unknown minute in that bucket still fences the strategy.
        closed_end = live.forming["start"]
        if not confirmed_window(db, revision, max(identity["history_start"], bar["start"]), closed_end,
                                value, phase, profiles):
            return wait(alert, runtime, "stale", "临时桶之前仍有未确认分钟，完整依赖未恢复")
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
                values[index] = Decimal(quote["bid"])
    if any(item["status"] != "complete" for item in progress):
        return wait(alert, runtime, "warming", "指标完整初始化或修订修复尚未完成", reset=False)
    if values[0] is None or config.condition.right and values[1] is None:
        return wait(alert, runtime, "warming", "完整有效依赖尚不足以初始化指标或画线观察")
    if config.seam_policy == "reject" and any(item.get("seam_dependency") for item in dependencies):
        return wait(alert, runtime, "blocked", "指标依赖包含原价接缝；需明确接受接缝影响或等待完整同源窗口")
    previous = page["bars"][-2] if len(page["bars"]) > 1 else None
    sequence = bar["end"] if config.mode == "close" else quote["source_time"]
    old_end = runtime.get("confirmed_end", 0)
    previous_input = runtime.get("processed_input_revision", value)
    earliest = db.scalar(select(func.min(CompositeMinuteInput.start)).where(
        CompositeMinuteInput.revision_id == revision.id,
        CompositeMinuteInput.input_revision > previous_input, CompositeMinuteInput.input_revision <= value,
        CompositeMinuteInput.start < old_end)) if value > previous_input else None
    correction = earliest is not None
    recovering = bool(runtime.get("recovering") or runtime.pop("closed", False) or
                      runtime.get("epoch", live.epoch) != live.epoch or correction)
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
        "source_epoch": live.epoch, "quote": dict(quote) if config.mode == "intrabar" else None,
        "observation_basis": "complete_close" if config.mode == "close" else "sampled_bid_quote"}
    sample = Observation(f"bar:{bar['start']}" if config.mode == "close" else f"sample:{sequence}",
        sequence, sequence, values[0], values[1], Decimal(str(quote["bid"] if config.mode == "intrabar" else bar["close"])), evidence)
    signal = consume(db, alert.id, sample, detected_at=now, baseline=baseline, expected_version=alert.version)
    judgment_id = digest([version.id, alert.run, revision.id, value, sequence, live.epoch, outcome])
    if not db.get(CompositeJudgment, judgment_id):
        db.add(CompositeJudgment(id=judgment_id, alert_version_id=version.id, revision_id=revision.id,
            history_version_id=identity["history_version_id"], input_revision=value, event_time=sequence,
            outcome="triggered" if signal else outcome, signal_id=signal.id if signal else None,
            evidence={**evidence, "left": str(values[0]), "right": str(values[1]) if values[1] is not None else None,
                      "rule_version": alert.version, "rule": version.config}))
    runtime.update(processed_input_revision=value, confirmed_end=bar["end"] if config.mode == "close" else
        max(runtime.get("confirmed_end", 0), previous["end"] if previous and previous["source_confirmed"] else 0),
        epoch=live.epoch, recovering=False, last_start=bar["start"],
        readiness={"ready": True, "status": "ready", "dependencies": dependencies, "last_outcome": outcome})
    alert.runtime = runtime
    alert.health, alert.health_reason = "ready", "恢复/接缝后已建立新基准，等待新事件" if baseline else None
    return [signal.id] if signal else []
