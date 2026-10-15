"""Transactional monitoring, shared historical context and simulated execution."""

from dataclasses import asdict
from decimal import Decimal

from sqlalchemy import select

from .calendar_profile import closures_from
from .chart_series import is_gold
from .domain import (
    Signal,
    State,
    advance,
    calendar_for,
    calendar_from,
    crossed,
    has_trading_gap,
    previous_session,
    shortened_h4,
)
from .replay_history import history_rows
from .storage import (
    Audit,
    Bar,
    Instrument,
    Notification,
    Outbox,
    Quote,
    SignalRow,
    Watch,
    candle_from,
    instant,
    ms,
    now_ms,
    rule_from,
    state_dict,
    state_from,
    uid,
)


def previous_day(db, instrument, bar, *, day_cache=None):
    session_start, session_end = previous_session(
        bar.start,
        calendar_for(instrument),
        gold=is_gold(instrument.id),
        closures=closures_from(instrument.calendar_profile),
    )
    if day_cache is not None:
        candidate = day_cache.get((ms(session_start), ms(session_end)))
        return candidate if candidate and candidate.complete else None
    # An incomplete latest session must not silently fall back to an older complete one.
    row = db.scalar(
        select(Bar)
        .where(
            Bar.instrument_id == instrument.id,
            Bar.timeframe == "D1",
            Bar.start == ms(session_start),
            Bar.end == ms(session_end),
        )
        .order_by(Bar.end.desc())
        .limit(1)
    )
    return row.candle() if row and row.complete else None


def create_watch(db, instrument_id, name, rule_dict, *, armed_at=None, use_history=True):
    instrument = db.scalar(
        select(Instrument).where(Instrument.id == instrument_id).with_for_update()
    )
    if not instrument:
        raise ValueError("Unknown instrument")
    if instrument.source == "composite":
        raise ValueError("组合策略须明确选择组合行情类型并固定输入修订")
    rule = rule_from(rule_dict)
    rule_dict = {
        **rule_dict,
        "version": rule.version,
        "indicator": rule.indicator,
        "indicator_version": rule.indicator_version,
        "indicator_params": dict(rule.indicator_params),
    }
    armed_at = now_ms() if armed_at is None else armed_at
    watch = Watch(
        instrument_id=instrument_id,
        name=name,
        rule=rule_dict,
        armed_at=armed_at,
        state=state_dict(State()),
    )
    state = State()
    if rule.timeframe == "tick":
        quote = db.get(Quote, instrument_id)
        watch.state = (
            {"quote": str(quote.bid), "quote_at": quote.at}
            if quote and 0 <= armed_at - quote.at < 120_000
            else {}
        )
        db.add(watch)
        db.flush()
        db.add(Audit(kind="watch_created", details={"watch_id": watch.id, "rule": rule_dict}))
        return watch
    if use_history:
        day_cache = (
            {
                (r.start, r.end): r.candle()
                for r in db.scalars(
                    select(Bar).where(
                        Bar.instrument_id == instrument_id,
                        Bar.timeframe == "D1",
                        Bar.end <= armed_at,
                    )
                )
            }
            if rule.kind == "previous_day"
            else None
        )
        history = db.scalars(
            select(Bar)
            .where(
                Bar.instrument_id == instrument_id,
                Bar.timeframe == rule.timeframe,
                Bar.end <= armed_at,
            )
            .order_by(Bar.start)
            .execution_options(yield_per=1000)
        )
        for row in history:
            if shortened_h4(
                row.candle(), rule.timeframe, closures_from(instrument.calendar_profile)
            ):
                state = State(last_event=row.candle().end)
                watch.warmup_start = None
                continue
            if not row.complete:
                # Knowledge starts afresh after an unresolved historical gap.
                state = State()
                watch.warmup_start = None
                continue
            if state.previous and has_trading_gap(
                state.previous.end,
                row.candle().start,
                calendar_for(instrument),
                gold=is_gold(instrument.id),
                closures=closures_from(instrument.calendar_profile),
            ):
                state = State()
                watch.warmup_start = None
            if watch.warmup_start is None:
                watch.warmup_start = row.start
            advance(
                rule,
                state,
                row.candle(),
                previous_day=previous_day(db, instrument, row.candle(), day_cache=day_cache)
                if rule.kind == "previous_day"
                else None,
            )
    watch.state = state_dict(state)
    db.add(watch)
    db.flush()
    db.add(Audit(kind="watch_created", details={"watch_id": watch.id, "rule": rule_dict}))
    return watch


def rewarm_watch(db, watch, *, until):
    """Rebuild same-source judgment state, suppressing every historical signal."""
    rule = rule_from(watch.rule)
    if rule.timeframe == "tick":
        watch.state = {}
        watch.paused_reason = None
        return
    instrument = db.get(Instrument, watch.instrument_id)
    state = State()
    from .indicators import get_indicator

    lookback = (get_indicator(rule.indicator, rule.indicator_version).lookback(rule.indicator_params) + 2
                if rule.kind == "indicator" else rule.consecutive + 2)
    rows = list(db.scalars(select(Bar).where(Bar.instrument_id == watch.instrument_id,
            Bar.timeframe == rule.timeframe, Bar.end <= until).order_by(Bar.start.desc())
            .limit(lookback)))
    for row in reversed(rows):
        if not row.complete or shortened_h4(row.candle(), rule.timeframe, closures_from(instrument.calendar_profile)):
            state = State(last_event=instant(row.end))
            continue
        if state.previous and has_trading_gap(state.previous.end, instant(row.start),
                calendar_for(instrument), gold=is_gold(instrument.id),
                closures=closures_from(instrument.calendar_profile)):
            state = State()
        day = previous_day(db, instrument, row.candle()) if rule.kind == "previous_day" else None
        if rule.kind == "previous_day" and day is None:
            state = State(last_event=instant(row.end))
            continue
        advance(rule, state, row.candle(), previous_day=day)
    watch.state = state_dict(state)
    watch.paused_reason = (
        "指标同源预热数据不足" if rule.kind == "indicator" and state.indicator_reading is None
        else "等待完整的同源判断前态" if state.previous is None else None
    )


def evaluate_watch(db, watch_id, *, emit_after=None):
    watch = db.scalar(select(Watch).where(Watch.id == watch_id).with_for_update())
    if not watch or watch.status != "active":
        return None
    rule = rule_from(watch.rule)
    if rule.timeframe == "tick":
        return None
    state = state_from(watch.state)
    instrument = db.get(Instrument, watch.instrument_id)
    cutoff = ms(state.last_event) if state.last_event else watch.armed_at
    rows = db.scalars(
        select(Bar)
        .where(
            Bar.instrument_id == watch.instrument_id,
            Bar.timeframe == rule.timeframe,
            Bar.end > cutoff,
        )
        .order_by(Bar.start)
    ).all()
    for row in rows:
        if row.end > now_ms():
            break
        if shortened_h4(row.candle(), rule.timeframe, closures_from(instrument.calendar_profile)):
            state = State(last_event=row.candle().end)
            watch.state = state_dict(state)
            watch.paused_reason = "已跳过休市缩短的 H4，等待重新建立准备状态"
            continue
        if not row.complete:
            watch.paused_reason = "K 线数据不完整，等待补齐"
            break
        if state.previous and has_trading_gap(
            state.previous.end,
            row.candle().start,
            calendar_for(instrument),
            gold=is_gold(instrument.id),
            closures=closures_from(instrument.calendar_profile),
        ):
            watch.paused_reason = "缺少中间 K 线，等待补数后恢复"
            break
        day = previous_day(db, instrument, row.candle())
        if rule.kind == "previous_day" and day is None:
            watch.paused_reason = "前一交易日数据尚未完整"
            break
        watch.paused_reason = None
        signal = advance(
            rule, state, row.candle(), previous_day=day, armed_at=instant(watch.armed_at)
        )
        watch.state = state_dict(state)
        if rule.kind == "indicator" and state.indicator_reading is None:
            watch.paused_reason = "指标同源预热数据不足"
        if signal:
            if emit_after is not None and row.end <= emit_after:
                db.add(Audit(kind="recovery_signal_suppressed", details={"watch_id": watch.id,
                    "instrument": instrument.id, "end": row.end, "reason": "expired_realtime_event"}))
                continue
            return record_signal(db, watch, instrument, signal)
    return None


def acknowledge(db, notification_id):
    note = db.scalar(
        select(Notification).where(Notification.id == notification_id).with_for_update()
    )
    if not note:
        raise ValueError("Notification not found")
    if note.ack_at is None:
        note.ack_at = now_ms()
        note.status = "acknowledged"
        task = db.scalar(select(Outbox).where(Outbox.notification_id == note.id))
        if task:
            task.status = "cancelled"
        db.add(Audit(kind="acknowledged", details={"notification_id": note.id}))
    return note


def replay_day(days, bar, calendar, *, gold=False, profile=None, explicit=False):
    start, end = previous_session(
        bar.start, calendar_from(calendar, profile, explicit=explicit), gold=gold, closures=closures_from(profile)
    )
    candidates = [d for d in days if d["start"] == ms(start) and d["end"] == ms(end)]
    latest = max(candidates, key=lambda d: d["end"]) if candidates else None
    return candle_from(latest) if latest and latest["complete"] else None


def add_replay_watch(run, name, rule_dict, calendar, *, use_history=True):
    rule = rule_from(rule_dict)
    rule_dict = {
        **rule_dict,
        "version": rule.version,
        "indicator": rule.indicator,
        "indicator_version": rule.indicator_version,
        "indicator_params": dict(rule.indicator_params),
    }
    if rule.timeframe != run.timeframe:
        raise ValueError("Replay watch timeframe must match replay timeframe")
    state = State()
    for d in history_rows(run) if use_history else []:
        if d["end"] > run.cursor:
            break
        if shortened_h4(candle_from(d), rule.timeframe, closures_from(run.calendar_profile)):
            state = State(last_event=candle_from(d).end)
            continue
        if not d["complete"]:
            state = State()
            continue
        b = candle_from(d)
        if state.previous and has_trading_gap(
            state.previous.end,
            b.start,
            calendar_from(calendar, run.calendar_profile, explicit=bool(run.dataset_version)),
            gold=is_gold(run.instrument_id),
            closures=closures_from(run.calendar_profile),
        ):
            state = State()
        advance(
            rule,
            state,
            b,
            previous_day=replay_day(
                run.days,
                b,
                calendar,
                gold=is_gold(run.instrument_id),
                profile=run.calendar_profile,
                explicit=bool(run.dataset_version),
            )
            if rule.kind == "previous_day"
            else None,
        )
    run.watches = [
        *run.watches,
        {
            "id": uid(),
            "name": name,
            "rule": rule_dict,
            "armed_at": run.cursor,
            "status": "active",
            "state": state_dict(state),
        },
    ]


def replay_step(run, calendar, count=1):
    rows = [d for d in run.bars if run.cursor < d["end"] <= run.end][:count]
    watches = [dict(w) for w in run.watches]
    signals = list(run.signals)
    for d in rows:
        run.cursor = d["end"]
        for w in watches:
            if w["status"] != "active":
                continue
            if shortened_h4(
                candle_from(d), rule_from(w["rule"]).timeframe, closures_from(run.calendar_profile)
            ):
                w["state"] = state_dict(State(last_event=candle_from(d).end))
                w["paused_reason"] = "已跳过休市缩短的 H4，等待重新建立准备状态"
                continue
            if not d["complete"]:
                w["paused_reason"] = "回放数据缺口，无法继续判断"
                w["status"] = "paused"
                continue
            state, rule = state_from(w["state"]), rule_from(w["rule"])
            b = candle_from(d)
            if state.previous and has_trading_gap(
                state.previous.end,
                b.start,
                calendar_from(calendar, run.calendar_profile, explicit=bool(run.dataset_version)),
                gold=is_gold(run.instrument_id),
                closures=closures_from(run.calendar_profile),
            ):
                w["status"] = "paused"
                w["paused_reason"] = "回放中间缺少 K 线"
                continue
            day = replay_day(
                run.days,
                b,
                calendar,
                gold=is_gold(run.instrument_id),
                profile=run.calendar_profile,
                explicit=bool(run.dataset_version),
            )
            if rule.kind == "previous_day" and day is None:
                w["status"] = "paused"
                w["paused_reason"] = "前日数据不完整"
                continue
            signal = advance(rule, state, b, previous_day=day, armed_at=instant(w["armed_at"]))
            w.pop("paused_reason", None)
            w["state"] = state_dict(state)
            if signal:
                signals.append(
                    {
                        **asdict(signal),
                        "evidence": {
                            **signal.evidence,
                            "calendar_profile": run.calendar_profile or {},
                        },
                        "occurred_at": ms(signal.occurred_at),
                        "price": str(signal.price),
                        "threshold": str(signal.threshold),
                        "watch_id": w["id"],
                    }
                )
                w["status"] = "triggered"
    run.watches, run.signals = watches, signals
    return len(rows)


def record_signal(db, watch, instrument, signal, *, event_key=None):
    from .storage import LiveState, MarketDataset

    provenance = {}
    dataset = db.scalar(select(MarketDataset).where(MarketDataset.instrument_id == instrument.id))
    if dataset:
        state = db.get(LiveState, dataset.id)
        provenance = {"dataset_identity": dataset.identity, "dataset_id": dataset.id,
                      "selection_epoch": state.epoch if state else None}
    record = SignalRow(
        **({"event_key": event_key} if event_key else {}),
        watch_id=watch.id,
        instrument_id=watch.instrument_id,
        occurred_at=ms(signal.occurred_at),
        direction=signal.direction,
        price=signal.price,
        threshold=signal.threshold,
        reason=signal.reason,
        evidence={
            **signal.evidence,
            "rule": watch.rule,
            "source": instrument.source,
            "basis": instrument.basis,
            "calendar_profile": instrument.calendar_profile,
            **provenance,
        },
    )
    db.add(record)
    db.flush()
    notification = Notification(signal_id=record.id)
    db.add(notification)
    db.flush()
    db.add(Outbox(notification_id=notification.id))
    watch.status = "triggered"
    db.add(Audit(kind="signal", details={"signal_id": record.id, "watch_id": watch.id}))
    return record


def evaluate_quote(db, instrument, at, bid, ask):
    if not bid.is_finite() or not ask.is_finite() or bid <= 0 or ask < bid:
        raise ValueError("Invalid quote")
    quote = db.get(Quote, instrument.id)
    if quote and at <= quote.at:
        return
    if quote:
        quote.at, quote.bid, quote.ask, quote.received_at = at, bid, ask, now_ms()
    else:
        db.add(Quote(instrument_id=instrument.id, at=at, bid=bid, ask=ask))
    for watch in db.scalars(
        select(Watch)
        .where(Watch.instrument_id == instrument.id, Watch.status == "active")
        .with_for_update()
    ).all():
        rule = rule_from(watch.rule)
        if rule.timeframe != "tick" or at <= watch.armed_at or at <= watch.state.get("quote_at", 0):
            continue
        prior = watch.state.get("quote")
        prior_at = watch.state.get("quote_at")
        watch.state = {"quote": str(bid), "quote_at": at}
        watch.paused_reason = None
        if prior is None:
            continue
        for up in (True, False):
            direction = "buy" if up else "sell"
            if rule.direction in ("both", direction) and crossed(
                Decimal(prior), bid, rule.level, up, rule.touch
            ):
                signal = Signal(
                    direction,
                    instant(at),
                    bid,
                    rule.level,
                    "即时报价上穿" if up else "即时报价下穿",
                    {
                        "previous_price": prior,
                        "previous_at": prior_at,
                        "observation_gap_ms": at - prior_at,
                        "timing": "between_observations",
                        "rule_version": rule.version,
                    },
                )
                record_signal(db, watch, instrument, signal)
                break


def evaluate_close_sample(db, instrument, at, close, *, received_at=None,
                          sequence=None, source_identity=None, interval_ms=None):
    """Evaluate a tick rule from two observed M1 close snapshots.

    REST candles have no bid/ask or tick timestamp. ``at`` is the observation
    clock (the response receive time); candle identity and response metadata
    remain separate evidence. The first valid sample establishes a baseline.
    """
    close = Decimal(str(close))
    if not close.is_finite() or close <= 0:
        raise ValueError("Invalid candle close")
    received_at = at if received_at is None else received_at
    for watch in db.scalars(
        select(Watch).where(Watch.instrument_id == instrument.id, Watch.status == "active")
        .with_for_update()
    ).all():
        rule = rule_from(watch.rule)
        if rule.timeframe != "tick" or at <= watch.armed_at:
            continue
        prior = watch.state.get("sample_close")
        prior_at = watch.state.get("sample_at")
        watch.state = {**watch.state, "sample_close": str(close), "sample_at": at,
                       "observation_mode": "candle_close_sample", "received_at": received_at,
                       **({"sequence": sequence} if sequence is not None else {})}
        watch.paused_reason = None
        if prior is None or prior_at is None or at <= prior_at:
            continue
        for up in (True, False):
            direction = "buy" if up else "sell"
            if rule.direction not in ("both", direction) or not crossed(
                    Decimal(prior), close, rule.level, up, rule.touch):
                continue
            evidence = {"previous_price": prior, "previous_at": prior_at,
                        "observation_gap_ms": at - prior_at,
                        "timing": "between_candle_observations",
                        "observation_mode": "candle_close_sample",
                        "received_at": received_at, "interval_ms": interval_ms,
                        "rule_version": rule.version}
            if sequence is not None:
                evidence["sequence"] = sequence
            if source_identity is not None:
                evidence["source_identity"] = source_identity
            record_signal(db, watch, instrument, Signal(
                direction, instant(at), close, rule.level,
                "当前价格采样上穿" if up else "当前价格采样下穿", evidence))
            break
