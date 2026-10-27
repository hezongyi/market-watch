"""Database-owned alert monitoring; no browser is needed to advance a run."""

import hashlib
import json
import logging
import time
from decimal import Decimal
from types import SimpleNamespace

from sqlalchemy import func, select

from .calendar_profile import closures_from
from .chart_alert_domain import Observation
from .chart_alert_service import AlertConfig, consume, current_version
from .chart_alert_values import operand_values
from .chart_calculation_history import calculation_rows
from .chart_data import chart_rows
from .chart_geometry_mapping import bar_indices
from .chart_labels import managed_label
from .domain import Calendar, scheduled_open
from .storage import (
    Bar,
    ChartAlert,
    ChartPublishedBar,
    Instrument,
    ProviderBar,
    ProviderDataset,
    instant,
    now_ms,
    transaction,
)

log = logging.getLogger(__name__)
_VALUE_CACHE = {}
_ATR_CACHE = {}
ATR_PAGE_ROWS = 2048


def atr_prefix_query(config, binding):
    if binding.get("dataset_id"):
        return ProviderBar, [ProviderBar.dataset_id == binding["dataset_id"]]
    model = ChartPublishedBar if config.published else Bar
    frame = binding["timeframe"]
    if not config.published:
        frame = "M15" if frame == "M30" else "D1" if frame in ("W1", "MN") else frame
    return model, [model.instrument_id == config.instrument, model.timeframe == frame]


def atr_price_digest(db, config, binding, end, checkpoint=None):
    """Extend a durable price digest; reread the prefix only on revision change.

    Provider/publication revisions include volume and observation metadata. A
    changed revision therefore requires comparing the actual ATR price inputs.
    Streaming keeps the exceptional verification bounded in memory.
    """
    checkpoint = checkpoint or {}
    digest = checkpoint.get("price_digest", "0" * 64)
    left = checkpoint.get("end", binding["origin"])
    model, filters = atr_prefix_query(config, binding)
    if model == Bar:
        query = select(model.start, model.end, model.open, model.high, model.low, model.close,
                       model.complete).where(*filters, model.start >= left, model.start < end)
    else:
        query = select(model.start, model.payload).where(*filters, model.start >= left, model.start < end)
    for record in db.execute(query.order_by(model.start).execution_options(yield_per=2048)):
        if model == Bar:
            start, stop, opened, high, low, close, complete = record
            payload = dict(start=start, end=stop, open=opened, high=high, low=low, close=close, complete=complete)
        else:
            payload = record.payload
        values = [payload["start"], payload["end"],
                  *[str(Decimal(str(payload[k])).normalize()) for k in ("open", "high", "low", "close")],
                  bool(payload["complete"]), bool(payload.get("gap_before")),
                  payload.get("source_confirmed", True), payload.get("coverage_complete", True)]
        digest = hashlib.sha256(bytes.fromhex(digest) + json.dumps(values, separators=(",", ":")).encode()).hexdigest()
    return digest


def atr_prefix_stamp(db, config, binding, end):
    """Compact revision fence, relying on the price writers' monotonic revisions.

    The database aggregates the indexed prefix; no historical OHLC payloads are
    loaded into the evaluator on every scan. Volume/observation-only updates of
    ordinary Bars do not alter their price revision.
    """
    model, filters = atr_prefix_query(config, binding)
    row = db.execute(select(func.count(), func.sum(model.revision), func.sum(model.start),
        func.min(model.start), func.max(model.start)).where(*filters,
            model.start >= binding["origin"], model.start < end)).one()
    return [int(value) if value is not None else None for value in row]


def offset_rows(db, version, config, now, runtime):
    """Read the independently bound timeframe; never borrow the main origin."""
    from .chart_alert_offsets import OffsetPending

    binding = version.market_identity["atr_dependency"]
    key = binding.get("dataset_id")
    checkpoint = runtime.get("atr_calculation", {"origin": binding["origin"]})
    if checkpoint.get("state") and "confirmation_watermark" not in checkpoint:
        # A pre-fix checkpoint cannot prove when its seed inputs were available.
        # Rebuild once from the same origin and safely recover the baseline.
        checkpoint = {"origin": binding["origin"]}
        runtime["offset_recovering"] = True
    if checkpoint.get("prefix_stamp") is not None:
        stamp = atr_prefix_stamp(db, config, binding, checkpoint["end"])
        if checkpoint["prefix_stamp"] != stamp:
            if not checkpoint.get("price_digest") or atr_price_digest(db, config, binding, checkpoint["end"]) != checkpoint["price_digest"]:
                raise ValueError("ATR 已判输入历史发生修订，等待核对及重建")
            checkpoint = {**checkpoint, "prefix_stamp": stamp}
            runtime["atr_calculation"] = checkpoint
    read_from = checkpoint.get("last_start", binding["origin"])
    atr_config = config.model_copy(update={"timeframe": config.condition.offset.timeframe,
                                           "calculation_origin": binding["origin"]})
    atr_version = SimpleNamespace(dataset_id=key, market_identity=version.market_identity)
    # Read forward from the pinned origin. A newest-N window can permanently
    # omit that origin on a long minute history. Cap on whole target buckets.
    model, filters = atr_prefix_query(config, binding)
    starts = list(db.scalars(select(model.start).where(*filters,
        model.start >= read_from, model.start <= now).order_by(model.start).limit(ATR_PAGE_ROWS + 1)))
    before = now + 1
    paged = len(starts) > ATR_PAGE_ROWS
    if paged:
        from .composite_series import period
        before = period(starts[-1], atr_config.timeframe, version.market_identity["calendar"])[0]
    rows, meta = stored_rows(db, atr_version, atr_config, now, fixed_origin=read_from,
                             read_from=read_from, before=before)
    rows = calculation_rows(rows, meta, config.instrument)
    rows = [row for row in rows if row["start"] >= read_from]
    if not rows or rows[0]["start"] != read_from:
        raise OffsetPending("ATR 独立固定历史起点缺失，等待已批准历史维护")
    return rows, meta, checkpoint, atr_config, paged


def fingerprint(rows):
    # Volume-only updates cannot change the first four supported indicators.
    return hashlib.sha256(json.dumps([
        [r["start"], r["end"], r["open"], r["high"], r["low"], r["close"],
         r["complete"], bool(r.get("gap_before"))] for r in rows
    ], separators=(",", ":")).encode()).hexdigest()


def health(alert, state, reason=None):
    alert.health, alert.health_reason = state, reason


def stored_rows(db, version, config, now, *, fixed_origin=None, read_from=None, before=None):
    if version.dataset_id:
        dataset = db.get(ProviderDataset, version.dataset_id)
        from .provider_cache import identity
        if not dataset or identity(dataset.metadata_json, config.timeframe) != version.dataset_id:
            raise ValueError("平台账户或数据集身份已改变，需显式编辑告警")
        query = select(ProviderBar).where(ProviderBar.dataset_id == version.dataset_id)
        if read_from is not None:
            query = query.where(ProviderBar.start >= read_from)
        if before is not None:
            query = query.where(ProviderBar.start < before)
        records = list(db.scalars(query.order_by(ProviderBar.start)))
        rows = [{**record.payload, "chart_time": record.chart_time,
                 "revision": record.revision, "observed_at": record.observed_at,
                 "confirmed_at": record.price_confirmed_at if record.price_confirmed_at is not None
                    else record.changed_at or record.observed_at}
                for record in records]
        return rows, dataset.metadata_json
    instrument = db.get(Instrument, config.instrument)
    if (not instrument or not instrument.enabled
            or instrument.source != version.market_identity["source"]
            or instrument.symbol != version.market_identity["symbol"]
            or instrument.basis != version.market_identity["basis"]
            or instrument.calendar != version.market_identity["calendar"]
            or instrument.calendar_profile != version.market_identity["calendar_profile"]):
        raise ValueError("持久行情身份已改变，需显式编辑告警")
    if config.published:
        from .managed_dataset import read_rows
        origin = config.calculation_origin
        if fixed_origin is not None:
            fixed_origin = max(fixed_origin, config.calculation_origin) if config.calculation_origin is not None else fixed_origin
            # The first retained row must keep its original gap_before value.
            # Read its nearest predecessor within the configured history, then
            # let calculation_rows segment before evaluate filters the origin.
            previous = read_rows(db, instrument, config.timeframe, fixed_origin, 1,
                                 dataset_start=config.calculation_origin)
            origin = previous[0]["start"] if previous else fixed_origin
        rows = read_rows(db, instrument, config.timeframe, before or now + 1, 100_000,
                         dataset_start=origin)
    else:
        rows = chart_rows(db, instrument, config.timeframe, before or now + 1, 100_000, now, observed=True,
                          after=read_from)
    rows = [{**row, "chart_time": managed_label(row, config.timeframe, config.instrument),
             "observed_at": row.get("observed_at", 0)} for row in rows]
    return rows, version.market_identity


def geometry_indices(rows, line, *, meta=None, config=None):
    if line.kind == "horizontal_line":
        return list(range(len(rows)))
    labels = {row.get("chart_time", row["start"]): i for i, row in enumerate(rows)}
    if rows and meta and config and any(p.time > max(labels) for p in line.points):
        labels = bar_indices(rows, instrument=config.instrument, timeframe=config.timeframe,
                             series_kind=config.series_kind, meta=meta, future=True)
    first = line.points[0]
    if first.time not in labels:
        raise ValueError("画线端点尚未映射到实际 K 线；等待历史或未来端点验证")
    origin = first.index - labels[first.time]
    for point in line.points[1:]:
        if point.time not in labels or point.index != origin + labels[point.time]:
            raise ValueError("画线端点的原生 K 线序号映射不一致")
    return [origin + i for i in range(len(rows))]


def evaluate(db, alert_id, *, now=None, values_cache=None):
    """Lock the run before reading its data; absent/incomplete data never advances it."""
    now = now_ms() if now is None else now
    alert = db.scalar(select(ChartAlert).where(ChartAlert.id == alert_id).with_for_update(skip_locked=True))
    if not alert or alert.status != "active":
        return []
    if alert.expires_at is not None and now >= alert.expires_at:
        alert.status = "expired"
        alert.control_revision += 1
        return []
    version = current_version(db, alert)
    config = AlertConfig.model_validate(version.config)
    if config.series_kind == "composite":
        from .composite_alerts import evaluate as evaluate_composite

        return evaluate_composite(db, alert, version, config, now)
    try:
        rows, meta = stored_rows(db, version, config, now,
                                 fixed_origin=alert.runtime.get("origin"))
    except ValueError as exc:
        health(alert, "blocked", str(exc))
        return []
    if meta["calendar"] not in ("ny17", "utc0"):
        health(alert, "blocked", "此来源的交易日历尚未通过告警一致性验证")
        return []
    calendar = Calendar(meta["calendar"])
    closures = closures_from(meta.get("calendar_profile"))
    rows = calculation_rows(rows, meta, config.instrument)
    if not rows:
        health(alert, "warming", "等待首个有效行情样本")
        return []
    runtime = dict(alert.runtime)
    if "origin" not in runtime:
        closed_before = [r for r in rows if r["complete"] and r["end"] <= alert.effective_at]
        baseline_rows = closed_before[-(config.warmup() + 2):]
        runtime["origin"] = (config.calculation_origin if config.calculation_origin is not None and config.indicators()
                             else rows[0]["start"] if config.indicators()
                             else baseline_rows[0]["start"] if baseline_rows else rows[0]["start"])
        if config.condition.right and config.condition.right.line:
            endpoint = min(p.time for p in config.condition.right.line.points)
            before_line = [r for r in rows if r.get("chart_time", r["start"]) <= endpoint]
            if before_line:
                runtime["origin"] = min(runtime["origin"], before_line[-1]["start"])
    rows = [r for r in rows if r["start"] >= runtime["origin"]]
    if not rows or rows[0]["start"] != runtime["origin"]:
        health(alert, "blocked", "计算历史起点缺失，等待恢复固定输入历史")
        return []
    # Historical revisions are visible and stop the run pending safe rebuild;
    # they cannot generate a new notification for the same historical event.
    committed = [r for r in rows if r["end"] <= runtime.get("confirmed_end", -1)]
    if runtime.get("fingerprint") and fingerprint(committed) != runtime["fingerprint"]:
        health(alert, "blocked", "已判历史发生修订，等待核对及重建；未重复发送历史事件")
        return []
    left = operand_values(rows, config.condition.left, provisional=config.mode == "intrabar", cache=values_cache)
    line = config.condition.right.line if config.condition.right else None
    try:
        indices = geometry_indices(rows, line, meta=meta, config=config) if line else None
    except ValueError as exc:
        health(alert, "blocked", str(exc))
        return []
    right = operand_values(rows, config.condition.right, provisional=config.mode == "intrabar",
                           indices=indices, cache=values_cache) if config.condition.right else [None] * len(rows)
    results = []
    atr_input = None
    if config.condition.offset:
        from .chart_alert_offsets import OffsetPending
        try:
            atr_input = offset_rows(db, version, config, now, runtime)
            atr_rows, atr_meta, checkpoint, atr_config, paged = atr_input
            if paged:
                from .chart_alert_offsets import ordinary_values, reference_bar
                candidates = [r for r in rows if config.mode == "intrabar" or r["end"] <= now]
                needed_end = reference_bar(candidates[-1]["start"], atr_config.timeframe,
                    atr_meta, config.instrument)[1] if candidates else 0
                if atr_rows[-1]["end"] < needed_end:
                    confirmed = [r for r in atr_rows if r["end"] <= now]
                    _, calculated = ordinary_values(confirmed, config.condition.offset, checkpoint, fingerprint, cache=_ATR_CACHE)
                    binding = version.market_identity["atr_dependency"]
                    end = calculated["end"]
                    runtime["atr_calculation"] = {**calculated,
                        "prefix_stamp": atr_prefix_stamp(db, config, binding, end),
                        "price_digest": atr_price_digest(db, config, binding, end, checkpoint)}
                    if alert.state:
                        runtime["offset_recovering"] = True
                    alert.runtime = runtime
                    health(alert, "warming", "ATR 固定历史分批初始化中，保留独立起点及检查点")
                    return []
        except (OffsetPending, ValueError) as exc:
            runtime["offset_recovering"] = True
            alert.runtime = runtime
            health(alert, "warming" if isinstance(exc, OffsetPending) else "blocked", str(exc))
            return []
    if config.mode == "intrabar":
        i = len(rows) - 1
        row = rows[i]
        at = row.get("observed_at", 0)
        if not at or now - at > 120_000 or at > now:
            if atr_input:
                runtime["offset_recovering"] = True
                alert.runtime = runtime
            if not scheduled_open(instant(now), calendar, gold=config.instrument == "XAUUSD", closures=closures):
                health(alert, "ready" if alert.state else "warming", "正常闭市，等待下一交易时段的新鲜观察值")
            else:
                health(alert, "stale", "抽样行情超过 120 秒，等待新鲜观察值")
            return []
        indices = [i]
    else:
        indices = range(len(rows))
        if atr_input and runtime.get("offset_recovering"):
            valid = [i for i, row in enumerate(rows) if row["end"] <= now and row["complete"]]
            indices = valid[-1:]
    for i in indices:
        row = rows[i]
        if config.mode == "close" and row["end"] > now:
            break
        checkpoint = alert.state.get("sequence", -1)
        sequence = row["end"] if config.mode == "close" else row["observed_at"]
        if sequence <= checkpoint:
            continue
        if config.mode == "close" and (not row["complete"] or row.get("gap_before")):
            if row["end"] > alert.effective_at:
                if atr_input:
                    runtime["offset_recovering"] = True
                health(alert, "stale", "缺少完整收盘或中间 K 线，等待补齐")
                break
            # Before activation only the last valid segment supplies a baseline.
            # Old gaps never fence observations in this new run.
            alert.state = {}
            if not row["complete"]:
                continue
        if left[i] is None or config.condition.right and right[i] is None:
            if atr_input:
                runtime["offset_recovering"] = True
            reason = ("当前观察值不在画线有效范围内，等待范围内的新样本"
                      if line and right[i] is None else "指标预热尚未完成")
            health(alert, "warming", reason)
            continue
        target, evidence = right[i], {"bar": row, "calculation_origin": runtime["origin"],
            "observation_basis": "complete_close" if config.mode == "close" else "sampled_candle_close"}
        baseline = bool(atr_input and config.mode == "intrabar" and alert.state.get("sequence") is not None
                        and sequence - alert.state["sequence"] > 120_000)
        if atr_input:
            from .chart_alert_offsets import apply, ordinary_values, reference_bar, resolve

            atr_rows, atr_meta, checkpoint, atr_config, paged = atr_input
            try:
                start, end = reference_bar(row["start"], atr_config.timeframe, atr_meta, config.instrument)
                reference = next((item for item in atr_rows if item["start"] == start and item["end"] == end), None)
                if not reference:
                    raise OffsetPending("最近预期 ATR 柱缺失，等待补齐；不使用更旧值")
                if not reference["complete"]:
                    raise OffsetPending("最近预期 ATR 柱尚未来源确认")
                # A repaired historical input cannot be claimed as known in a
                # previous real-time sample. Recovery starts at today's sample.
                prior_offset = runtime.get("offset", {})
                reference_fingerprint = fingerprint([reference])
                already_confirmed = (prior_offset.get("reference_start") == start
                    and prior_offset.get("reference_fingerprint") == reference_fingerprint)
                confirmed_at = reference.get("confirmed_at", reference.get("observed_at", 0))
                if not already_confirmed and confirmed_at > sequence:
                    runtime["offset_recovering"] = True
                    health(alert, "warming", "ATR 参考输入确认晚于观察时点，等待安全恢复基准")
                    continue
                needed = [item for item in atr_rows if item["end"] <= end]
                values, calculated = ordinary_values(needed, config.condition.offset, checkpoint,
                                                       fingerprint, cache=_ATR_CACHE)
                if calculated["confirmation_watermark"] > sequence:
                    runtime["offset_recovering"] = True
                    health(alert, "warming", "ATR 递归输入确认晚于观察时点，等待安全恢复基准")
                    continue
                binding = version.market_identity["atr_dependency"]
                calculated = {**calculated, "prefix_stamp": atr_prefix_stamp(db, config, binding, end),
                    "price_digest": atr_price_digest(db, config, binding, end, checkpoint)}
                resolved = resolve(config.condition.offset, config.condition.relation, row, reference,
                    values.get(str(start)), dependency={**version.market_identity["atr_dependency"],
                        "confirmed_end": end, "input_fingerprint": fingerprint(needed)})
                resolved["available_at"] = sequence
                resolved["confirmed_at"] = confirmed_at
                resolved["confirmation_watermark"] = calculated["confirmation_watermark"]
                resolved["reference_fingerprint"] = reference_fingerprint
                if already_confirmed:
                    resolved["confirmed_at"] = prior_offset["confirmed_at"]
                target = apply(target, resolved)
                evidence["offset"] = resolved
                recovering = runtime.pop("offset_recovering", False)
                baseline = baseline or recovering
                runtime["atr_calculation"] = calculated
                # Subsequent observations in this transaction share new state.
                atr_input = (atr_rows, atr_meta, calculated, atr_config, paged)
            except OffsetPending as exc:
                if sequence <= alert.effective_at:
                    continue
                runtime["offset_recovering"] = True
                health(alert, "warming", str(exc))
                break
        sample = Observation(f"bar:{row['start']}" if config.mode == "close" else f"sample:{sequence}",
                             sequence, sequence, left[i], target, Decimal(str(row["close"])), evidence)
        alert.runtime = runtime
        event = consume(db, alert.id, sample, detected_at=now, baseline=baseline, expected_version=alert.version)
        runtime = dict(alert.runtime)
        if event:
            results.append(event.id)
        if config.mode == "close":
            runtime["confirmed_end"] = row["end"]
        if alert.status != "active":
            break
    committed = [r for r in rows if r["end"] <= runtime.get("confirmed_end", -1)]
    if config.mode == "intrabar" and rows:
        confirmed = [row["end"] for row in rows[:-1] if row["complete"] and row["end"] <= now]
        if confirmed:
            runtime["confirmed_end"] = max(confirmed)
        committed = [r for r in rows if r["end"] <= runtime.get("confirmed_end", -1)]
    runtime["fingerprint"] = fingerprint(committed)
    alert.runtime = runtime
    if alert.health == "ready" and config.mode == "close" and now - rows[-1]["end"] > 120_000:
        is_open = scheduled_open(instant(now), calendar, gold=config.instrument == "XAUUSD", closures=closures)
        if is_open and now - rows[-1]["end"] > max(120_000, rows[-1]["end"] - rows[-1]["start"]):
            health(alert, "stale", "交易时段内尚无新的完整 K 线")
        elif not is_open:
            health(alert, "ready", "正常闭市，等待下一交易时段")
    return results


def step(*, now=None, on_evaluated=None):
    with transaction() as db:
        ids = list(db.scalars(select(ChartAlert.id).where(ChartAlert.status == "active")))
    for ident in ids:
        started = time.monotonic()
        try:
            with transaction() as db:
                business_now = now_ms() if now is None else now
                row = db.scalar(select(ChartAlert).where(ChartAlert.id == ident)
                    .with_for_update(skip_locked=True))
                if row is None or row.status != "active":
                    continue
                version = current_version(db, row)
                config = AlertConfig.model_validate(version.config)
                if config.series_kind != "composite":
                    row.status = "paused"
                    row.control_revision += 1
                    health(row, "blocked", "旧来源告警已退役；请改用组合行情重新创建")
                else:
                    evaluate(db, ident, now=business_now, values_cache=_VALUE_CACHE)
                if on_evaluated:
                    row = db.get(ChartAlert, ident)
                    observation = dict(alert_id=ident, read_started=started,
                        evaluation_finished=time.monotonic(),
                        business_now=business_now, sequence=row.state.get('sequence') if row else None,
                        count=row.count if row else None, health=row.health if row else None,
                        status=row.status if row else None, commit_started=time.monotonic())
        except Exception as exc:
            log.exception("Chart alert evaluation failed for %s", ident)
            with transaction() as db:
                row = db.get(ChartAlert, ident)
                if row and row.status == "active":
                    health(row, "error", "判定失败：" + type(exc).__name__)
            continue
        if on_evaluated:
            # Evidence collection failures propagate to the monitor, without
            # rewriting the already committed business state as an error.
            on_evaluated(dict(**observation, committed=time.monotonic()))
