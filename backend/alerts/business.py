"""Shared browser and agent business Interface; no request or session identity."""


from fastapi import HTTPException
from sqlalchemy import select

from .calendar_profile import closures_from
from .chart_series import is_gold
from .domain import TIMEFRAMES, calendar_for, scheduled_open
from .service import acknowledge
from .storage import (
    Bar,
    DeviceReceipt,
    Instrument,
    MarketDataset,
    Notification,
    Outbox,
    Quote,
    SignalRow,
    candle_dict,
    instant,
    now_ms,
    transaction,
)


def instruments():
    from .live_pricing import snapshots

    live = {row["instrument_id"]: row for row in snapshots()}
    with transaction() as db:
        datasets = {row.instrument_id: row for row in db.scalars(select(MarketDataset))}
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
                            "symbol",
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
                            calendar_for(inst),
                            gold=is_gold(inst.id),
                            closures=closures_from(inst.calendar_profile),
                        )
                        else "stale"
                        if now_ms() - latest.end > 180_000
                        else "receiving"
                    ),
                    "age_seconds": (now_ms() - latest.end) // 1000 if latest else None,
                }
            )
            dataset = datasets.get(inst.id)
            if dataset:
                result[-1].update(
                    logical_symbol=dataset.logical_symbol,
                    dataset_identity=dataset.identity,
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
                calendar_for(inst),
                gold=is_gold(inst.id),
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
            if inst.id in live:
                snapshot = live[inst.id]
                bid = snapshot["quote"].get("bid")
                result[-1].update(
                    logical_symbol=snapshot["logical_symbol"],
                    label=f'{snapshot["logical_symbol"]} · OANDA practice',
                    dataset_identity=snapshot["identity"],
                    quality=snapshot["quality"],
                    live_status=snapshot,
                    price=bid or result[-1]["price"],
                    price_at=snapshot["quote"].get("source_time") or result[-1]["price_at"],
                )
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












def signals(signal_id: str | None = None):
    with transaction() as db:
        rows = db.execute(
            select(SignalRow, Notification)
            .join(Notification, Notification.signal_id == SignalRow.id)
            .where(SignalRow.id == signal_id if signal_id else True)
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
                and s.chart_alert_id is not None and s.watch_id is None and n.ack_at is None,
                "retired": s.watch_id is not None and s.chart_alert_id is None,
                "reminder_status": "退役停止提醒" if s.watch_id is not None and s.chart_alert_id is None else n.status,
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
