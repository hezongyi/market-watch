"""Transactional monitoring, shared historical context and simulated execution."""

from dataclasses import asdict
from decimal import Decimal

from sqlalchemy import select

from .calendar_profile import closures_from
from .domain import (
    Calendar,
    Signal,
    State,
    advance,
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
        Calendar(instrument.calendar),
        gold=instrument.id == "XAUUSD",
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
                Calendar(instrument.calendar),
                gold=instrument.id == "XAUUSD",
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


def evaluate_watch(db, watch_id):
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
            Calendar(instrument.calendar),
            gold=instrument.id == "XAUUSD",
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
        if signal:
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


def replay_day(days, bar, calendar, *, gold=False, profile=None):
    start, end = previous_session(
        bar.start, Calendar(calendar), gold=gold, closures=closures_from(profile)
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
            Calendar(calendar),
            gold=run.instrument_id == "XAUUSD",
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
                gold=run.instrument_id == "XAUUSD",
                profile=run.calendar_profile,
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
                Calendar(calendar),
                gold=run.instrument_id == "XAUUSD",
                closures=closures_from(run.calendar_profile),
            ):
                w["status"] = "paused"
                w["paused_reason"] = "回放中间缺少 K 线"
                continue
            day = replay_day(
                run.days,
                b,
                calendar,
                gold=run.instrument_id == "XAUUSD",
                profile=run.calendar_profile,
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


def record_signal(db, watch, instrument, signal):
    record = SignalRow(
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
