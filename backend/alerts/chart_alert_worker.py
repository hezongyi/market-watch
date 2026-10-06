"""Database-owned alert monitoring; no browser is needed to advance a run."""

import hashlib
import json
import logging
from decimal import Decimal

from sqlalchemy import select

from .calendar_profile import closures_from
from .chart_alert_domain import Observation
from .chart_alert_service import AlertConfig, consume, current_version
from .chart_alert_values import operand_values
from .chart_data import chart_rows
from .chart_history_plan import bucket_has_trading
from .domain import Calendar, scheduled_open
from .storage import (
    Bar,
    ChartAlert,
    Instrument,
    ProviderBar,
    ProviderDataset,
    instant,
    now_ms,
    transaction,
)

log = logging.getLogger(__name__)


def fingerprint(rows):
    # Volume-only updates cannot change the first four supported indicators.
    return hashlib.sha256(json.dumps([
        [r["start"], r["end"], r["open"], r["high"], r["low"], r["close"],
         r["complete"], bool(r.get("gap_before"))] for r in rows
    ], separators=(",", ":")).encode()).hexdigest()


def health(alert, state, reason=None):
    alert.health, alert.health_reason = state, reason


def stored_rows(db, version, config, now):
    if version.dataset_id:
        dataset = db.get(ProviderDataset, version.dataset_id)
        records = list(db.scalars(select(ProviderBar).where(
            ProviderBar.dataset_id == version.dataset_id,
        ).order_by(ProviderBar.start)))
        rows = [{**record.payload, "chart_time": record.chart_time,
                 "revision": record.revision, "observed_at": record.observed_at}
                for record in records]
        return rows, dataset.metadata_json
    instrument = db.get(Instrument, config.instrument)
    if (instrument.source != version.market_identity["source"]
            or instrument.symbol != version.market_identity["symbol"]
            or instrument.basis != version.market_identity["basis"]
            or instrument.calendar_profile != version.market_identity["calendar_profile"]):
        raise ValueError("持久行情身份已改变，需显式编辑告警")
    rows = chart_rows(db, instrument, config.timeframe, now + 1, 100_000, now)
    stamps = {r.start: r.observed_at or r.received_at for r in db.scalars(select(Bar).where(
        Bar.instrument_id == config.instrument, Bar.timeframe == config.timeframe,
    ))}
    rows = [{**row, "observed_at": stamps.get(row["start"], 0)} for row in rows]
    return rows, version.market_identity


def geometry_indices(rows, line):
    if line.kind == "horizontal_line":
        return list(range(len(rows)))
    labels = {row.get("chart_time", row["start"]): i for i, row in enumerate(rows)}
    first = line.points[0]
    if first.time not in labels:
        raise ValueError("画线端点尚未映射到实际 K 线；等待历史或未来端点验证")
    origin = first.index - labels[first.time]
    for point in line.points[1:]:
        if point.time not in labels or point.index != origin + labels[point.time]:
            raise ValueError("画线端点的原生 K 线序号映射不一致")
    return [origin + i for i in range(len(rows))]


def evaluate(db, alert_id, *, now=None):
    """Lock the run before reading its data; absent/incomplete data never advances it."""
    now = now_ms() if now is None else now
    alert = db.scalar(select(ChartAlert).where(ChartAlert.id == alert_id).with_for_update(skip_locked=True))
    if not alert or alert.status != "active":
        return []
    if alert.expires_at is not None and now >= alert.expires_at:
        alert.status = "expired"
        return []
    version = current_version(db, alert)
    config = AlertConfig.model_validate(version.config)
    rows, meta = stored_rows(db, version, config, now)
    if meta["calendar"] not in ("ny17", "utc0"):
        health(alert, "blocked", "此来源的交易日历尚未通过告警一致性验证")
        return []
    calendar = Calendar(meta["calendar"])
    closures = closures_from(meta.get("calendar_profile"))
    for previous, row in zip(rows, rows[1:]):
        if row["start"] > previous["end"]:
            row["gap_before"] = bucket_has_trading(instant(previous["end"]), instant(row["start"]),
                                                   calendar, config.instrument == "XAUUSD", closures)
    if not rows:
        health(alert, "warming", "等待首个有效行情样本")
        return []
    runtime = dict(alert.runtime)
    if "origin" not in runtime:
        closed_before = [r for r in rows if r["complete"] and r["end"] <= alert.effective_at]
        baseline_rows = closed_before[-(config.warmup() + 2):]
        runtime["origin"] = baseline_rows[0]["start"] if baseline_rows else rows[0]["start"]
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
    left = operand_values(rows, config.condition.left, provisional=config.mode == "intrabar")
    line = config.condition.right.line if config.condition.right else None
    try:
        indices = geometry_indices(rows, line) if line else None
    except ValueError as exc:
        health(alert, "blocked", str(exc))
        return []
    right = operand_values(rows, config.condition.right, provisional=config.mode == "intrabar",
                           indices=indices) if config.condition.right else [None] * len(rows)
    results = []
    if config.mode == "intrabar":
        i = len(rows) - 1
        row = rows[i]
        at = row.get("observed_at", 0)
        if not at or now - at > 120_000 or at > now:
            health(alert, "stale", "抽样行情超过 120 秒，等待新鲜观察值")
            return []
        indices = [i]
    else:
        indices = range(len(rows))
    for i in indices:
        row = rows[i]
        if config.mode == "close" and row["end"] > now:
            break
        checkpoint = alert.state.get("sequence", -1)
        sequence = row["end"] if config.mode == "close" else row["observed_at"]
        if sequence <= checkpoint:
            continue
        if config.mode == "close" and (not row["complete"] or row.get("gap_before")):
            health(alert, "stale", "缺少完整收盘或中间 K 线，等待补齐")
            break
        if left[i] is None or config.condition.right and right[i] is None:
            health(alert, "warming", "指标预热尚未完成")
            continue
        sample = Observation(f"bar:{row['start']}" if config.mode == "close" else f"sample:{sequence}",
                             sequence, sequence, left[i], right[i], Decimal(str(row["close"])),
                             {"bar": row, "calculation_origin": runtime["origin"],
                              "observation_basis": "complete_close" if config.mode == "close" else "sampled_candle_close"})
        event = consume(db, alert.id, sample, detected_at=now, expected_version=alert.version)
        if event:
            results.append(event.id)
        if config.mode == "close":
            runtime["confirmed_end"] = row["end"]
        if alert.status != "active":
            break
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


def step(*, now=None):
    with transaction() as db:
        ids = list(db.scalars(select(ChartAlert.id).where(ChartAlert.status == "active")))
    for ident in ids:
        try:
            with transaction() as db:
                evaluate(db, ident, now=now)
        except Exception as exc:
            log.exception("Chart alert evaluation failed for %s", ident)
            with transaction() as db:
                row = db.get(ChartAlert, ident)
                if row and row.status == "active":
                    health(row, "error", "判定失败：" + type(exc).__name__)
