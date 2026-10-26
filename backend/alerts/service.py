"""Historical and ChartAlert notification confirmation with one lock order."""


from sqlalchemy import select

from .storage import (
    Audit,
    Notification,
    Outbox,
    now_ms,
)


def acknowledge(db, notification_id):
    note = db.scalar(
        select(Notification).where(Notification.id == notification_id).with_for_update()
    )
    if not note:
        raise ValueError("Notification not found")
    if note.ack_at is None:
        note.ack_at = now_ms()
        note.status = "acknowledged"
        task = db.scalar(select(Outbox).where(Outbox.notification_id == note.id).with_for_update())
        if task:
            task.status = "cancelled"
        db.add(Audit(kind="acknowledged", details={"notification_id": note.id}))
    return note
