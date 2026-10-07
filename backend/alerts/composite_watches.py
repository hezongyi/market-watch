"""Existing strategy kinds bound to an immutable composite input contract.

Creation pins data but never copies target-source bars into legacy storage.
The domain rule/state retain their existing strict schemas. Background strategy
preparation owns runtime/readiness; a newly created binding is explicitly warming.
"""

import copy
from dataclasses import replace
from decimal import Decimal
from types import SimpleNamespace

from sqlalchemy import func, select

from .calendar_profile import closures_from
from .composite_series import period
from .domain import Signal, State, advance, calendar_from, crossed, previous_session, scheduled_open
from .fixed_indicators import ALGORITHM, digest, gap_before, input_rows
from .storage import (
    Audit,
    CompositeAggregateTask,
    CompositeMinuteInput,
    CompositePreparation,
    CompositeRevision,
    CompositeWatchBinding,
    CompositeWatchJudgment,
    HistoryVersion,
    Instrument,
    MarketComposite,
    MarketDataset,
    RealtimeMapping,
    SignalRow,
    Watch,
    candle_from,
    instant,
    ms,
    now_ms,
    rule_from,
    state_dict,
    state_from,
    transaction,
)

CONTRACT = "composite-watch-input-v1"


def create(db, instrument, name, rule_dict, *, revision_id=None, seam_policy="reject",
           use_history=True, armed_at=None):
    from .composite_alerts import bind

    if seam_policy not in ("reject", "accept_raw"):
        raise ValueError("需要明确的接缝依赖政策")
    rule = rule_from(rule_dict)
    identity = bind(db, SimpleNamespace(instrument=instrument, composite_revision_id=revision_id,
        calculation_origin=None, timeframe=rule.timeframe, seam_policy=seam_policy))
    normalized = {**rule_dict, "version": rule.version, "indicator": rule.indicator,
                  "indicator_version": rule.indicator_version, "indicator_params": dict(rule.indicator_params)}
    identity = {**identity, "contract": CONTRACT, "rule_version": rule.version, "fixed_rule": normalized,
        "strategy_kind": rule.kind, "observation_mode": "sampled_bid_quote" if rule.timeframe == "tick" else "complete_close"}
    # Serialize creation with instrument/reference writers. first_use and bind
    # already validate the fixed historical baseline, mapping and account.
    db.scalar(select(Instrument.id).where(Instrument.id == identity["instrument_id"]).with_for_update())
    stamp = now_ms() if armed_at is None else armed_at
    watch = Watch(instrument_id=identity["instrument_id"], name=name,
        rule=normalized,
        state={} if rule.timeframe == "tick" else state_dict(State()), armed_at=stamp,
        paused_reason="组合策略等待固定周期及完整依赖预热")
    db.add(watch)
    db.flush()
    binding = CompositeWatchBinding(watch_id=watch.id, revision_id=identity["composite_revision_id"],
        history_version_id=identity["history_version_id"], market_identity=identity,
        use_history=use_history, health="warming", health_reason=watch.paused_reason,
        runtime={"recovering": True, "readiness": {"ready": False, "status": "warming",
            "reason": watch.paused_reason}}, updated_at=stamp, created_at=stamp)
    db.add(binding)
    db.add(Audit(kind="watch_created", details={"watch_id": watch.id, "rule": watch.rule,
        "market_identity": identity, "use_history": use_history}))
    db.flush()
    return watch


def describe(binding):
    return {"series_kind": "composite", "market_identity": binding.market_identity,
        "health": binding.health, "health_reason": binding.health_reason,
        "runtime": binding.runtime, "use_history": binding.use_history}


def affected(db, composite_id):
    return [(binding, watch) for binding, watch in db.execute(select(CompositeWatchBinding, Watch).join(
        Watch, Watch.id == CompositeWatchBinding.watch_id).where(Watch.status == "active"))
        if binding.market_identity["composite_id"] == composite_id]


def impact(db, composite_id):
    return [{"id": watch.id, "name": watch.name, "rule_version": watch.rule["version"],
        "strategy_kind": watch.rule["kind"], "revision_id": binding.revision_id,
        "migration": "keeps_fixed_revision"} for binding, watch in affected(db, composite_id)]


def waiting(watch, binding, runtime, health, reason, *, reset=True):
    if reset:
        runtime["recovering"] = True
    binding.health, binding.health_reason = health, reason
    runtime["readiness"] = {"ready": False, "status": health, "reason": reason}
    binding.runtime, watch.paused_reason = runtime, reason
    return None


def context(db, binding):
    identity = binding.market_identity
    revision = db.get(CompositeRevision, binding.revision_id)
    composite = db.get(MarketComposite, identity["composite_id"])
    version = db.get(HistoryVersion, binding.history_version_id)
    mapping = db.get(RealtimeMapping, revision.mapping_id) if revision else None
    target = db.get(MarketDataset, mapping.target_dataset_id) if mapping else None
    from .history_catalog import account_scope

    if (identity["contract"] != CONTRACT or identity["calculation_algorithm"] != ALGORITHM or
            not composite or composite.permission_scope != "workspace:default" or not revision or
            revision.composite_id != composite.id or not version or
            revision.history_version_id != version.id or version.manifest["checksum"] != identity["history_checksum"] or
            revision.rules != identity["rules"] or revision.seam != identity["seam"] or not target or
            target.identity != identity["target_identity"] or target.identity["account_scope"] != account_scope()):
        raise ValueError("固定组合基线、映射、账户或算法已改变，请新建规则")
    list(db.scalars(select(MarketDataset.id).where(MarketDataset.id.in_(
        sorted({version.dataset_id, target.id}))).order_by(MarketDataset.id).with_for_update()))
    return revision, version, target


def day_context(db, revision, bar, value, now, cache):
    from .composite_chart import chart_page

    phase = revision.rules["aggregation_calendar"]
    key = (period(bar["start"], "D1", phase)[0], bar["start"] >= revision.seam)
    if key in cache:
        return cache[key]
    version = db.get(HistoryVersion, revision.history_version_id)
    target = db.get(MarketDataset, db.get(RealtimeMapping, revision.mapping_id).target_dataset_id)
    profile = (version.manifest.get("calendar_profile", {}) if bar["start"] < revision.seam else
               db.get(Instrument, target.instrument_id).calendar_profile)
    left, right = previous_session(instant(bar["start"]), calendar_from(phase, profile, explicit=True),
                                   closures=closures_from(profile))
    if ms(right) <= 0:
        cache[key] = None
        return None
    page = chart_page(db, revision.composite_id, "D1", before=ms(right), count=1,
        revision_id=revision.id, input_revision=value, provisional=False, now=now)
    rows = page["bars"]
    cache[key] = rows[-1] if not page["pending"] and rows and rows[-1]["start"] == ms(left) and (
        rows[-1]["end"] == ms(right) and rows[-1]["complete"]) else None
    return cache[key]


def safe_step(db, watch, binding, runtime, revision, state, bar, value, now, *, emit=False, profiles=None, day_cache=None):
    """Full dependency tracking, with a fresh comparison baseline at the seam."""
    rule = rule_from(watch.rule)
    version = db.get(HistoryVersion, revision.history_version_id)
    if profiles is None:
        target = db.get(MarketDataset, db.get(RealtimeMapping, revision.mapping_id).target_dataset_id)
        profiles = [(version.start, revision.seam, version.manifest.get("calendar_profile", {})),
            (revision.seam, now + 1, db.get(Instrument, target.instrument_id).calendar_profile)]
    prior_end = ms(state.previous.end) if state.previous else None
    seam = bool(bar.get("seam_crossing") or bar.get("seam_at_start") or
        state.previous and ms(state.previous.start) < revision.seam <= bar["start"])
    if bar.get("seam_crossing") and binding.market_identity["seam_policy"] == "reject":
        runtime["dependencies"] = []
        runtime["dependency_reason"] = "判断桶跨原价接缝，等待完整同源窗口"
        return State(last_event=instant(bar["end"])), None, False
    gap = gap_before(prior_end, bar["start"], revision.rules["aggregation_calendar"], profiles)
    if gap or not bar["complete"]:
        state = State(last_event=instant(bar["end"]))
        runtime["dependencies"] = []
        runtime["dependency_reason"] = "判断依赖存在缺口或未确认数据"
        if not bar["complete"]:
            return state, None, False
        state = State()
    if seam:
        if rule.kind == "indicator" and binding.market_identity["seam_policy"] == "accept_raw":
            # Keep the exact full-origin SMA window, suppress only the event
            # comparison across sources, then continue with a new baseline.
            state.previous = None
        else:
            state = State()
            runtime["dependencies"] = []
    day = day_context(db, revision, bar, value, now, day_cache if day_cache is not None else {}) if rule.kind == "previous_day" else None
    day_allowed = bool(day and (binding.market_identity["seam_policy"] == "accept_raw" or
        not day.get("mixed_source") and not day["start"] < revision.seam <= bar["start"]))
    dependency = {"start": bar["start"], "end": bar["end"], "segments": bar.get("segments", [
        {"segment": "history", "start": bar["start"], "end": bar["end"],
         "input": {"history_version_id": version.id, "checksum": version.manifest["checksum"]}}]),
        "coverage_complete": bar["coverage_complete"], "source_confirmed": bar["source_confirmed"],
        "time_closed": bar["time_closed"], "seam_dependency": seam}
    deps = runtime.get("dependencies", [])
    length = rule.indicator_params["slow"] + 1 if rule.kind == "indicator" else 2
    runtime["dependencies"] = [*deps, dependency][-length:]
    if rule.kind == "previous_day" and not day_allowed:
        state = State(last_event=instant(bar["end"]))
        runtime["dependency_reason"] = "前一完整交易日尚未发布或跨源日线依赖未被明确接受"
        return state, None, False
    armed = instant(watch.armed_at) if emit and not seam and not gap else None
    signal = advance(rule, state, candle_from(bar), previous_day=candle_from(day) if day else None, armed_at=armed)
    ready = state.previous is not None and (rule.kind != "indicator" or state.indicator_reading is not None)
    runtime["dependency_reason"] = None if ready else "指标完整连续预热依赖不足"
    runtime["previous_day"] = day
    # Pullback readiness can persist arbitrarily long. Preserve its origin,
    # rather than pretending the last consecutive+2 bars reconstruct it.
    if rule.kind == "pullback":
        runtime.setdefault("formation_origin", bar["start"])
        if seam or gap or not (state.buy_ready or state.sell_ready):
            runtime["formation_origin"] = bar["start"]
    return state, signal, ready


def judgment(db, watch, binding, runtime, value, sequence, outcome, evidence, signal=None):
    ident = digest([watch.id, watch.rule["version"], binding.revision_id, value, sequence,
        runtime.get("epoch"), outcome])
    if not db.get(CompositeWatchJudgment, ident):
        db.add(CompositeWatchJudgment(id=ident, watch_id=watch.id, revision_id=binding.revision_id,
            history_version_id=binding.history_version_id, input_revision=value, event_time=sequence,
            outcome=outcome, signal_id=signal.id if signal else None,
            evidence={"market_identity": binding.market_identity, "rule": watch.rule,
                "input_revision": value, "dependencies": runtime.get("dependencies", []),
                "formation_origin": runtime.get("formation_origin"), **evidence}))


def publish_signal(db, watch, binding, runtime, value, signal):
    from .service import record_signal

    # Input corrections and connection epochs cannot create another logical
    # event: the key deliberately excludes both.
    key = "cw:" + digest([watch.id, watch.rule["version"], binding.market_identity["composite_id"],
        binding.revision_id, watch.rule["timeframe"], ms(signal.occurred_at)])
    existing = db.scalar(select(SignalRow).where(SignalRow.event_key == key))
    if existing:
        return None
    signal = replace(signal, evidence={**signal.evidence, "market_identity": binding.market_identity,
        "input_revision": value, "dependencies": copy.deepcopy(runtime.get("dependencies", [])),
        "formation_origin": runtime.get("formation_origin"), "previous_day": runtime.get("previous_day"),
        "source_epoch": runtime["epoch"], "observation_basis": binding.market_identity["observation_mode"]})
    record = record_signal(db, watch, db.get(Instrument, watch.instrument_id), signal, event_key=key)
    return record


def evaluate(db, watch_id, *, now=None):
    from .composite_chart import chart_page
    from .composite_quotes import live_snapshot

    stamp = now_ms() if now is None else now
    watch = db.scalar(select(Watch).where(Watch.id == watch_id).with_for_update(skip_locked=True))
    if not watch or watch.status != "active":
        return None
    binding = db.get(CompositeWatchBinding, watch.id)
    if not binding:
        return None
    runtime = copy.deepcopy(binding.runtime)
    binding.updated_at = stamp
    try:
        revision, version, target = context(db, binding)
        if watch.rule != binding.market_identity["fixed_rule"]:
            raise ValueError("规则已改变，请新建策略并保留旧固定输入")
    except ValueError as error:
        return waiting(watch, binding, runtime, "blocked", str(error))
    prep = db.get(CompositePreparation, revision.id)
    value, rule = prep.input_revision, rule_from(watch.rule)
    if prep.status != "queried" or prep.error:
        return waiting(watch, binding, runtime, "warming", "确认M1接续准备或恢复尚未完成")
    live = live_snapshot(db, revision, now=stamp)
    profile = db.get(Instrument, target.instrument_id).calendar_profile
    phase = revision.rules["aggregation_calendar"]
    is_open = scheduled_open(instant(stamp), calendar_from(phase, profile, explicit=True), closures=closures_from(profile))
    if not is_open:
        runtime["closed"] = True
        binding.runtime = runtime
        binding.health_reason = "已证实闭市，等待下一时段建立新观察基准"
        watch.paused_reason = None if binding.health == "ready" else binding.health_reason
        return None
    if not live["confirmed_tail_ready"]:
        return waiting(watch, binding, runtime, "stale", "确认来源断线、拥有者过期或恢复未就绪")
    if rule.timeframe == "tick":
        return evaluate_tick(db, watch, binding, runtime, revision, value, live, stamp)
    frames = {rule.timeframe, *(["D1"] if rule.kind == "previous_day" else [])}
    for frame in frames:
        task = db.get(CompositeAggregateTask, (revision.id, frame))
        if not task or task.applied_input_revision < value:
            return waiting(watch, binding, runtime, "warming", "所需周期尚未处理完整固定输入；等待聚合水位", reset=False)
    page = chart_page(db, revision.composite_id, rule.timeframe, revision_id=revision.id,
        input_revision=value, provisional=False, count=3, now=stamp)
    closed = [row for row in page["bars"] if row["end"] <= stamp]
    if page["pending"] or not closed:
        return waiting(watch, binding, runtime, "warming", "等待固定历史周期及有效确认观察", reset=False)
    bar = closed[-1]
    if not binding.use_history and bar["end"] <= watch.armed_at:
        return waiting(watch, binding, runtime, "warming", "未选择历史预热；等待开启后的首个完整确认周期", reset=False)
    if bar["start"] < revision.seam or not bar["complete"] or live["source_confirmed_end"] < bar["end"]:
        return waiting(watch, binding, runtime, "stale", "判断周期的完整覆盖及确认水位尚未就绪")
    expected = period(max(0, stamp - 30000), rule.timeframe, phase)[0]
    if bar["end"] < expected:
        return waiting(watch, binding, runtime, "stale", "所需周期尚无新鲜完整收盘；不补发旧事件")
    processed = runtime.get("processed_input_revision", value)
    old_end = runtime.get("confirmed_end", 0)
    changed = db.scalar(select(func.min(CompositeMinuteInput.start)).where(
        CompositeMinuteInput.revision_id == revision.id, CompositeMinuteInput.input_revision > processed,
        CompositeMinuteInput.input_revision <= value, CompositeMinuteInput.start < old_end)) if value > processed else None
    epoch = live["connection_epoch"]
    state = state_from(watch.state)
    previous = closed[-2] if len(closed) > 1 else None
    missed = bool(old_end and bar["end"] > old_end and (not previous or previous["end"] != old_end))
    rebuild = (runtime.get("recovering") or runtime.pop("closed", False) or
        runtime.get("epoch", epoch) != epoch or changed is not None or missed or not old_end)
    if rebuild and "warmup" not in runtime:
        origin = period(version.start if binding.use_history else watch.armed_at, rule.timeframe, phase)[0]
        runtime["warmup"] = {"cursor": origin, "target_end": bar["end"], "input_revision": value,
            "origin": origin, "reason": "recovery_baseline" if old_end else "initial_baseline"}
        runtime["dependencies"] = []
        runtime.pop("formation_origin", None)
        state = State()
    if "warmup" in runtime:
        warmup = runtime["warmup"]
        # A correction inside the selected warming prefix restarts that prefix.
        changed_warmup = db.scalar(select(func.min(CompositeMinuteInput.start)).where(
            CompositeMinuteInput.revision_id == revision.id,
            CompositeMinuteInput.input_revision > warmup["input_revision"],
            CompositeMinuteInput.input_revision <= value,
            CompositeMinuteInput.start < warmup["target_end"])) if value > warmup["input_revision"] else None
        if changed_warmup is not None or runtime.get("epoch", epoch) != epoch:
            runtime.pop("warmup")
            runtime["epoch"] = epoch
            return waiting(watch, binding, runtime, "warming", "预热输入已修订或连接世代改变；重建固定依赖")
        selected = warmup["input_revision"]
        job = SimpleNamespace(history_version_id=version.id, revision_id=revision.id, timeframe=rule.timeframe,
            input_revision=selected, cursor=warmup["cursor"], target_end=warmup["target_end"])
        try:
            inputs = input_rows(db, job)
        except ValueError as error:
            return waiting(watch, binding, runtime, "warming", str(error), reset=False)
        if inputs is None:
            return waiting(watch, binding, runtime, "warming", "固定预热周期尚未处理完整输入", reset=False)
        rows, _, _ = inputs
        profiles = [(version.start, revision.seam, version.manifest.get("calendar_profile", {})),
                    (revision.seam, stamp + 1, profile)]
        ready = False
        day_cache = {}
        for row in rows:
            state, _, ready = safe_step(db, watch, binding, runtime, revision, state, row, selected, stamp,
                profiles=profiles, day_cache=day_cache)
        watch.state = state_dict(state)
        if rows:
            warmup["cursor"] = rows[-1]["end"]
        runtime["epoch"] = epoch
        if len(rows) == 2000 and warmup["cursor"] < warmup["target_end"]:
            return waiting(watch, binding, runtime, "warming", "后台分批预热固定历史；尚未完成完整前缀", reset=False)
        if not rows or warmup["cursor"] != warmup["target_end"]:
            runtime.pop("warmup")
            return waiting(watch, binding, runtime, "stale", "固定预热输入未覆盖判断周期；等待修复")
        if warmup["target_end"] < bar["end"]:
            # Long prefixes can take longer than a live minute. Continue the
            # verified checkpoint through append-only inputs; restarting the
            # entire prefix on every new minute would never become ready.
            warmup.update(target_end=bar["end"], input_revision=value)
            return waiting(watch, binding, runtime, "warming", "完整历史预热已推进，继续接续新增确认周期", reset=False)
        runtime.update(confirmed_end=warmup["target_end"], processed_input_revision=selected, recovering=False)
        outcome = warmup["reason"]
        runtime.pop("warmup")
        judgment(db, watch, binding, runtime, selected, runtime["confirmed_end"], outcome,
            {"current_bar": rows[-1], "state": watch.state, "emitted": False})
        binding.health = "ready" if ready else "warming"
        binding.health_reason = "恢复/初始化后已建立基准，等待新事件" if ready else runtime["dependency_reason"]
        watch.paused_reason = None if ready else binding.health_reason
        runtime["readiness"] = {"ready": ready, "status": binding.health, "dependencies": runtime["dependencies"]}
        binding.runtime = runtime
        return None
    if bar["end"] <= old_end:
        runtime["processed_input_revision"] = value
        if runtime.get("readiness", {}).get("ready"):
            binding.health, binding.health_reason, watch.paused_reason = "ready", None, None
        binding.runtime = runtime
        return None
    before = copy.deepcopy(watch.state)
    fresh = stamp - bar["end"] <= 120000 and bar["end"] > watch.armed_at
    state, signal, ready = safe_step(db, watch, binding, runtime, revision, state, bar, value, stamp, emit=fresh)
    watch.state = state_dict(state)
    runtime.update(confirmed_end=bar["end"], processed_input_revision=value, epoch=epoch, recovering=False)
    record = publish_signal(db, watch, binding, runtime, value, signal) if signal else None
    judgment(db, watch, binding, runtime, value, bar["end"], "triggered" if record else "evaluated" if fresh else "expired_baseline",
        {"current_bar": bar, "previous_state": before, "state": watch.state}, record)
    binding.health = "ready" if ready else "warming"
    binding.health_reason = None if ready else runtime["dependency_reason"]
    watch.paused_reason = binding.health_reason
    runtime["readiness"] = {"ready": ready, "status": binding.health, "dependencies": runtime["dependencies"]}
    binding.runtime = runtime
    return record


def evaluate_tick(db, watch, binding, runtime, revision, value, live, now):
    from .composite_alerts import confirmed_window

    quote = live["quote"]
    if not live["quote_ready"] or quote["source_time"] < revision.seam:
        return waiting(watch, binding, runtime, "stale", "抽样报价过期、世代不符或不可交易；不追认未观测触价")
    version = db.get(HistoryVersion, revision.history_version_id)
    target = db.get(MarketDataset, db.get(RealtimeMapping, revision.mapping_id).target_dataset_id)
    profile = db.get(Instrument, target.instrument_id).calendar_profile
    minute_start = quote["source_time"] // 60000 * 60000
    profiles = [(version.start, revision.seam, version.manifest.get("calendar_profile", {})),
                (revision.seam, now + 1, profile)]
    if not confirmed_window(db, revision, max(revision.seam, minute_start - 60000), minute_start,
                            value, revision.rules["aggregation_calendar"], profiles):
        return waiting(watch, binding, runtime, "stale", "报价之前仍有未确认分钟，等待完整依赖恢复")
    sequence = quote["source_time"]
    prior_at = watch.state.get("quote_at", 0)
    processed = runtime.get("processed_input_revision", value)
    correction = db.scalar(select(func.min(CompositeMinuteInput.start)).where(
        CompositeMinuteInput.revision_id == revision.id, CompositeMinuteInput.input_revision > processed,
        CompositeMinuteInput.input_revision <= value,
        CompositeMinuteInput.start < runtime.get("confirmed_end", minute_start))) if value > processed else None
    recovering = bool(runtime.get("recovering") or runtime.pop("closed", False) or correction is not None or
        runtime.get("epoch", live["connection_epoch"]) != live["connection_epoch"] or sequence - prior_at > 15000)
    if sequence < prior_at:
        return waiting(watch, binding, runtime, "stale", "旧时间报价不回退判断水位")
    if sequence == prior_at and not recovering:
        return None
    prior = watch.state.get("quote")
    price = Decimal(quote["bid"])
    rule = rule_from(watch.rule)
    runtime["epoch"] = live["connection_epoch"]
    runtime["dependencies"] = [{"kind": "sampled_bid", "quote": quote, "received_at": live["received_at"]}]
    signal = None
    if prior is not None and not recovering and sequence > watch.armed_at:
        for up in (True, False):
            direction = "buy" if up else "sell"
            if rule.direction in ("both", direction) and crossed(Decimal(prior), price, rule.level, up, rule.touch):
                signal = Signal(direction, instant(sequence), price, rule.level,
                    "抽样Bid报价上穿" if up else "抽样Bid报价下穿",
                    {"previous_price": prior, "previous_at": prior_at, "quote": quote,
                        "observation_gap_ms": sequence - prior_at, "timing": "between_observations"})
                break
    watch.state = {"quote": str(price), "quote_at": sequence}
    runtime.update(recovering=False, processed_input_revision=value, confirmed_end=minute_start,
                   readiness={"ready": True, "status": "ready", "dependencies": runtime["dependencies"]})
    record = publish_signal(db, watch, binding, runtime, value, signal) if signal else None
    judgment(db, watch, binding, runtime, value, sequence, "triggered" if record else "recovery_baseline" if recovering else "evaluated",
        {"quote": quote, "previous_price": prior, "previous_at": prior_at}, record)
    binding.health, binding.health_reason, watch.paused_reason = "ready", None, None
    binding.runtime = runtime
    return record


def step(*, now=None):
    import logging

    with transaction() as db:
        ids = list(db.scalars(select(CompositeWatchBinding.watch_id).join(
            Watch, Watch.id == CompositeWatchBinding.watch_id).where(Watch.status == "active")
            .order_by(CompositeWatchBinding.updated_at, CompositeWatchBinding.watch_id)))
    for ident in ids:
        try:
            with transaction() as db:
                evaluate(db, ident, now=now)
        except Exception as error:
            logging.getLogger(__name__).exception("Composite strategy failed for %s", ident)
            with transaction() as db:
                watch = db.scalar(select(Watch).where(Watch.id == ident).with_for_update())
                binding = db.get(CompositeWatchBinding, ident)
                if watch and binding and watch.status == "active":
                    waiting(watch, binding, copy.deepcopy(binding.runtime), "error", "判定失败：" + type(error).__name__)
