"""Shared browser and agent business Interface; no request or session identity."""

from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import select

from .calendar_profile import closures_from
from .domain import TIMEFRAMES, Calendar, scheduled_open
from .service import acknowledge, create_watch
from .storage import (
    Audit,
    Bar,
    DeviceReceipt,
    Instrument,
    Notification,
    Outbox,
    Quote,
    SignalRow,
    Watch,
    candle_dict,
    instant,
    now_ms,
    rule_from,
    transaction,
)


def watch_dict(w):
    return {
        k: getattr(w, k)
        for k in (
            "id",
            "instrument_id",
            "name",
            "rule",
            "state",
            "status",
            "armed_at",
            "paused_reason",
            "warmup_start",
        )
    }


class WatchInput(BaseModel):
    instrument_id: Literal["EURUSD", "XAUUSD", "BTCUSD", "BTCUSDT"]
    name: str = Field(min_length=1, max_length=100)
    kind: Literal["pullback", "previous_day", "price", "indicator"]
    timeframe: str = "H4"
    direction: Literal["buy", "sell", "both"] = "both"
    consecutive: int = Field(default=2, ge=2, le=100)
    level: str | None = None
    touch: bool = False
    use_history: bool = True
    indicator: str = "sma_cross"
    indicator_version: str = "1"
    indicator_params: dict = Field(default_factory=dict)

    def rule(self):
        return {
            k: getattr(self, k)
            for k in [
                "kind",
                "timeframe",
                "direction",
                "consecutive",
                "level",
                "touch",
                "indicator",
                "indicator_version",
                "indicator_params",
            ]
        }

    @model_validator(mode="after")
    def check_rule(self):
        rule_from(self.rule())
        return self


def instruments():
    with transaction() as db:
        result = []
        for inst in db.scalars(
            select(Instrument).where(Instrument.enabled.is_(True)).order_by(Instrument.id)
        ):
            latest = db.scalar(
                select(Bar)
                .where(Bar.instrument_id == inst.id, Bar.timeframe == "M1")
                .order_by(Bar.start.desc())
                .limit(1)
            )
            result.append(
                {
                    **{
                        k: getattr(inst, k)
                        for k in [
                            "id",
                            "label",
                            "source",
                            "basis",
                            "calendar",
                            "calendar_profile",
                            "precision",
                            "quality",
                            "last_received",
                            "error",
                        ]
                    },
                    "price": str(latest.close) if latest else None,
                    "price_at": latest.end if latest else None,
                    "price_type": "M1 close",
                    "quality": (
                        "error"
                        if inst.error
                        else "waiting"
                        if latest is None
                        else "closed"
                        if not scheduled_open(
                            instant(now_ms()),
                            Calendar(inst.calendar),
                            gold=inst.id == "XAUUSD",
                            closures=closures_from(inst.calendar_profile),
                        )
                        else "stale"
                        if now_ms() - latest.end > 180_000
                        else "receiving"
                    ),
                    "age_seconds": (now_ms() - latest.end) // 1000 if latest else None,
                }
            )
            quote = db.get(Quote, inst.id)
            if quote and (not latest or quote.at > latest.end):
                result[-1].update(
                    price=str(quote.bid),
                    price_at=quote.at,
                    price_type="last trade" if inst.basis == "last" else "bid quote",
                    quality="receiving" if now_ms() - quote.at < 120_000 else "stale",
                    age_seconds=(now_ms() - quote.at) // 1000,
                )
            market_open = scheduled_open(
                instant(now_ms()),
                Calendar(inst.calendar),
                gold=inst.id == "XAUUSD",
                closures=closures_from(inst.calendar_profile),
            )
            result[-1]["market_open"] = market_open
            age = result[-1]["age_seconds"]
            result[-1]["is_stale"] = age is not None and age > (
                180 if result[-1]["price_type"] == "M1 close" else 120
            )
            if inst.error:
                result[-1]["quality"] = "error"
            elif not market_open and result[-1]["price"] is not None:
                result[-1]["quality"] = "closed"
        return result


def candles(instrument: str, timeframe: str = "H4", before: int | None = None, limit: int = 300):
    if timeframe not in TIMEFRAMES or not 1 <= limit <= 2000:
        raise HTTPException(422, "周期或数量不正确")
    with transaction() as db:
        q = select(Bar).where(
            Bar.instrument_id == instrument,
            Bar.timeframe == timeframe,
            Bar.start < (before if before is not None else now_ms()),
        )
        return [
            candle_dict(b.candle())
            for b in reversed(db.scalars(q.order_by(Bar.start.desc()).limit(limit)).all())
        ]


def watches(limit=None, offset=0, instrument=None, status=None):
    with transaction() as db:
        query = select(Watch).order_by(Watch.created_at.desc(), Watch.id)
        if instrument:
            query = query.where(Watch.instrument_id == instrument)
        if status:
            query = query.where(Watch.status == status)
        if limit is not None:
            query = query.offset(offset).limit(limit)
        return [watch_dict(w) for w in db.scalars(query)]


def new_watch(body: WatchInput):
    with transaction() as db:
        return new_watch_in(db, body)


def new_watch_in(db, body):
    try:
        return watch_dict(
            create_watch(
                db, body.instrument_id, body.name, body.rule(), use_history=body.use_history
            )
        )
    except ValueError as e:
        raise HTTPException(422, str(e))


def cancel_watch(watch_id):
    with transaction() as db:
        return cancel_watch_in(db, watch_id)


def cancel_watch_in(db, watch_id):
    w = db.scalar(select(Watch).where(Watch.id == watch_id).with_for_update())
    if not w:
        raise HTTPException(404, "监控不存在")
    if w.status == "active":
        w.status = "cancelled"
        db.add(Audit(kind="watch_cancelled", details={"watch_id": watch_id}))
    return watch_dict(w)


def signals():
    with transaction() as db:
        rows = db.execute(
            select(SignalRow, Notification)
            .join(Notification, Notification.signal_id == SignalRow.id)
            .order_by(SignalRow.created_at.desc())
            .limit(500)
        ).all()
        received_ids = set(
            db.scalars(
                select(DeviceReceipt.notification_id).where(
                    DeviceReceipt.notification_id.in_([n.id for _, n in rows])
                )
            )
        )
        return [
            {
                **{
                    k: getattr(s, k)
                    for k in [
                        "id",
                        "watch_id",
                        "chart_alert_id",
                        "instrument_id",
                        "occurred_at",
                        "created_at",
                        "direction",
                        "reason",
                        "evidence",
                    ]
                },
                "price": str(s.price),
                "threshold": str(s.threshold),
                "notification_id": n.id,
                "notification_status": n.status,
                "ack_at": n.ack_at,
                "device_delivery": "received" if n.id in received_ids else "unknown",
                "retry_available": db.scalar(
                    select(Outbox.status).where(Outbox.notification_id == n.id)
                )
                == "blocked"
                and n.ack_at is None,
            }
            for s, n in rows
        ]


def ack(notification_id):
    with transaction() as db:
        return ack_in(db, notification_id)


def ack_in(db, notification_id):
    try:
        n = acknowledge(db, notification_id)
        return {"id": n.id, "status": n.status}
    except ValueError:
        raise HTTPException(404, "通知不存在")
