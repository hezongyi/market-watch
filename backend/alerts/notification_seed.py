"""D1 acceptance-only seed for the unified notification center (Issue #75).

Creates committed source rows (signal + notification + audit) so the async
projector can be exercised without waiting for live market conditions. Refuses
to run unless ALERTS_ACCEPTANCE_SEED=1 is set in an isolated acceptance stack.
"""

from __future__ import annotations

import argparse
import os
import sys
from decimal import Decimal

from sqlalchemy import func, select

from .storage import (
    Audit,
    Instrument,
    Notification,
    Outbox,
    SignalRow,
    bootstrap,
    now_ms,
    transaction,
    uid,
)


def _require_acceptance() -> None:
    if os.environ.get("ALERTS_ACCEPTANCE_SEED") != "1":
        sys.exit("notification seed is acceptance-only; set ALERTS_ACCEPTANCE_SEED=1")


def add_signal(db, index: int, *, alert_id: str, instrument_id: str = "EURUSD",
               spacing_ms: int = 60_000, notify_web: bool = True,
               notify_ntfy: bool = True) -> SignalRow:
    if not db.get(Instrument, instrument_id):
        raise SystemExit(f"unknown instrument {instrument_id}")
    occurred = now_ms() - index * spacing_ms
    signal = SignalRow(
        instrument_id=instrument_id, occurred_at=occurred, direction="up",
        price=Decimal("1.10000"), threshold=Decimal("1.09000"),
        reason=f"验收规则 {alert_id}",
        evidence={
            "chart_alert": True, "alert_id": alert_id, "rule_version": 4,
            "config": {"timeframe": "M5", "notify_web": notify_web,
                       "notify_ntfy": notify_ntfy, "name": alert_id},
            "market_identity": {"symbol": instrument_id, "source": "dukascopy"},
            "run": 7, "ordinal": index + 1, "detected_at": occurred,
            "left": "1.10000", "threshold": "1.09000", "unit": "price",
        },
    )
    db.add(signal)
    db.flush()
    notification = Notification(signal_id=signal.id, created_at=occurred)
    db.add(notification)
    db.flush()
    if notify_ntfy:
        db.add(Outbox(notification_id=notification.id))
    db.add(Audit(kind="chart_alert_signal",
                 details={"signal_id": signal.id, "alert_id": alert_id}))
    db.flush()
    return signal


def seed_signals(count: int, alert: str, instrument: str, spacing_ms: int,
                 same_alert: bool) -> list[str]:
    ids: list[str] = []
    with transaction() as db:
        for index in range(count):
            alert_id = alert if same_alert else f"{alert}-{index}"
            signal = add_signal(db, index, alert_id=alert_id,
                                instrument_id=instrument, spacing_ms=spacing_ms)
            ids.append(signal.id)
    return ids


def latest_notifications(limit: int) -> list[Notification]:
    with transaction() as db:
        return list(db.scalars(
            select(Notification).order_by(Notification.created_at.desc()).limit(limit)))


def add_delivery(notification_id: str, accepted: bool, attempt: int) -> None:
    with transaction() as db:
        db.add(Audit(kind="notification_delivery", details={
            "kind": "delivery", "notification_id": notification_id,
            "attempt_id": attempt * 1000 + int(notification_id[:2], 16),
            "status": "accepted" if accepted else "failed_or_unknown",
            "at": now_ms(), "error": None if accepted else "acceptance_fixture",
            "provider_id": "acc-provider" if accepted else None}))


def add_receipt(notification_id: str, device_id: str) -> None:
    with transaction() as db:
        db.add(Audit(kind="notification_receipt", details={
            "kind": "receipt", "notification_id": notification_id,
            "device_id": device_id, "received_at": now_ms()}))


def main() -> None:
    _require_acceptance()
    parser = argparse.ArgumentParser()
    parser.add_argument("--signals", type=int, default=0)
    parser.add_argument("--alert", default="acc")
    parser.add_argument("--instrument", default="EURUSD")
    parser.add_argument("--spacing-ms", type=int, default=60_000)
    parser.add_argument("--same-alert", action="store_true")
    parser.add_argument("--deliver-latest", type=int, default=0)
    parser.add_argument("--fail-latest", type=int, default=0)
    parser.add_argument("--receipt-latest", type=int, default=0)
    parser.add_argument("--device", default="acc-device")
    parser.add_argument("--summary", action="store_true")
    args = parser.parse_args()

    bootstrap()
    if args.signals:
        ids = seed_signals(args.signals, args.alert, args.instrument,
                           args.spacing_ms, args.same_alert)
        print(f"signals={len(ids)} alert={args.alert} same_alert={args.same_alert}")
    if args.deliver_latest or args.fail_latest:
        rows = latest_notifications(max(args.deliver_latest, args.fail_latest))
        for index, note in enumerate(rows[: args.deliver_latest]):
            add_delivery(note.id, True, index + 1)
        for index, note in enumerate(rows[: args.fail_latest]):
            add_delivery(note.id, False, index + 100)
        print(f"deliveries accepted={args.deliver_latest} failed={args.fail_latest}")
    if args.receipt_latest:
        rows = latest_notifications(args.receipt_latest)
        for note in rows:
            add_receipt(note.id, args.device)
        print(f"receipts={len(rows)}")
    if args.summary:
        from .storage import NotificationEvent

        with transaction() as db:
            events = db.scalar(select(func.count()).select_from(NotificationEvent)) or 0
            signals = db.scalar(select(func.count()).select_from(SignalRow)) or 0
        print(f"signals={signals} projected_events={events}")


if __name__ == "__main__":
    main()
