"""Preview/apply legacy Watch retirement; historical evidence is never deleted.

Run once during a maintenance window with legacy evaluators and delivery stopped.
No API startup hook invokes this command. The caller owns the transaction.
"""

import argparse
import json

from sqlalchemy import select

from .storage import Audit, Notification, Outbox, SignalRow, Watch, now_ms, transaction

REASON = "legacy_watch_retired_single_frontend"
UNFINISHED = ("pending", "sending", "blocked")


def legacy_signal(signal):
    return signal is not None and signal.watch_id is not None and signal.chart_alert_id is None


def current_signal(signal):
    return signal is not None and signal.chart_alert_id is not None and signal.watch_id is None


def retire(db, *, apply=False, at=None):
    stamp = now_ms() if at is None else at
    watches = list(db.scalars(select(Watch).where(Watch.status.in_(("active", "paused")))
        .order_by(Watch.id).with_for_update()))
    candidates = list(db.execute(select(Notification.id, Outbox.id).join(
        SignalRow, SignalRow.id == Notification.signal_id).join(
        Watch, Watch.id == SignalRow.watch_id).outerjoin(Outbox, Outbox.notification_id == Notification.id)
        .where(SignalRow.chart_alert_id.is_(None), Notification.ack_at.is_(None),
            (Outbox.status.in_(UNFINISHED)) | ((Outbox.id.is_(None)) &
                Notification.status.in_(("pending", "quiet", "delivery_error"))))
        .order_by(Notification.id)))
    changes, in_flight = [], []
    for note_id, task_id in candidates:
        # Same lock order as confirmation and claim: Notification -> Outbox.
        note = db.scalar(select(Notification).where(Notification.id == note_id).with_for_update())
        task = db.scalar(select(Outbox).where(Outbox.id == task_id).with_for_update()) if task_id else None
        if note.ack_at is not None or task and task.status not in UNFINISHED:
            continue
        if task and task.status == "sending" and (task.lease_until or 0) > stamp:
            in_flight.append(task.id)
        changes.append({"notification_id": note.id, "outbox_id": task.id if task else None,
            "previous_notification_status": note.status, "previous_outbox_status": task.status if task else None,
            "notification_status": "retired", "outbox_status": "cancelled" if task else None})
    report = {"apply": apply, "reason": REASON, "watches": [{"id": row.id,
        "previous_status": row.status, "status": "cancelled"} for row in watches],
        "notifications": changes, "in_flight": in_flight,
        "counts": {"watches": len(watches), "notifications": len(changes)}}
    if apply and in_flight:
        raise ValueError("旧投递仍在领取期内；请停止投递 worker 并等待在途投递结束后重试")
    if apply:
        for row in watches:
            row.status = "cancelled"
        for change in changes:
            note = db.get(Notification, change["notification_id"])
            note.status = "retired"
            if change["outbox_id"]:
                task = db.get(Outbox, change["outbox_id"])
                task.status, task.lease_until = "cancelled", None
                task.error = REASON
        if watches or changes:
            db.add(Audit(kind="legacy_watch_retired", at=stamp,
                details={"reason": REASON, "watches": report["watches"], "notifications": changes}))
        db.flush()
        report["verified"] = all(row.status == "cancelled" for row in watches) and all(
            db.get(Notification, change["notification_id"]).status == "retired" and
            db.get(Notification, change["notification_id"]).ack_at is None for change in changes)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Modify state; default is preview only")
    args = parser.parse_args()
    with transaction() as db:
        report = retire(db, apply=args.apply)
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
