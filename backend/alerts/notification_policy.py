"""Runtime health is operational information, separate from requested price alerts."""
from sqlalchemy import select

from .storage import DeliveryAttempt, Notification, Outbox, Preference

RUNTIME_PUSH_DELAY_MS = 180_000


def accepted(db, notification_id):
    return bool(notification_id and db.scalar(select(DeliveryAttempt.id).where(
        DeliveryAttempt.notification_id == notification_id,
        DeliveryAttempt.status == "accepted").limit(1)))


def current_runtime_faults(db, note, *, at=None):
    """A retry must still describe the same continuous failure episode."""
    result = []
    for fault in note.payload.get("context", {}).get("runtime_faults", []):
        row = db.get(Preference, "runtime_incident:" + fault["id"])
        value = row.value if row else {}
        if value.get("state") == "active" and value.get("opened_at") == fault["opened_at"]:
            if at is not None:
                from .runtime_health import expected_roles, key, restarts
                group, role = fault["id"].split(":", 1)
                if role == "boot_loop":
                    if group not in {item[0] for item in restarts(db, at=at)}:
                        continue
                else:
                    if fault["id"] not in expected_roles():
                        continue
                    health = db.get(Preference, key(role))
                    state = health.value if health else {}
                    if (state.get("checked_at") and not state.get("error_type")
                            and at - state["checked_at"] < state.get("stale_after_ms", 15000)):
                        continue
            result.append(fault)
    return result


def obsolete_system_notice(db, note, *, at):
    payload = note.payload
    incident = payload.get("incident_id", "")
    if payload.get("resolved_at"):
        return True
    if (incident.startswith("runtime-recovery:") or incident.endswith(":recovery")) and at - note.created_at > 300_000:
        return True  # Old recovery information must not outlive a later failure/retry backlog.
    if incident.startswith("runtime-faults:"):
        # Old queued summaries have no episode identity: never replay them as a current fault.
        return not current_runtime_faults(db, note, at=at)
    if incident.startswith("runtime-recovery:"):
        return not any(accepted(db, ident) for ident in payload.get("context", {}).get("recovery_of", []))
    return False


def resolve_runtime_notices(db, notification_ids, *, at):
    """Retain records and receipts; resolving never acknowledges on the user's behalf."""
    for ident in notification_ids:
        note = db.scalar(select(Notification).where(Notification.id == ident).with_for_update())
        if not note or current_runtime_faults(db, note):
            continue
        note.payload = {**note.payload, "resolved_at": at}
        row = db.scalar(select(Outbox).where(Outbox.notification_id == ident).with_for_update())
        if row and row.status in ("pending", "blocked", "sending"):
            row.status = "cancelled"
            if not note.ack_at:
                note.status = "resolved"
