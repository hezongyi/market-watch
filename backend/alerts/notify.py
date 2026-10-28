"""Outbox publisher. A server receipt never means the handset received the message."""

import argparse
import hashlib
import secrets
import threading
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import httpx
from sqlalchemy import or_, select

from .chart_alert_message import signal_message, signal_title
from .config import settings
from .retire_legacy import current_signal
from .storage import (
    AckGrant,
    Audit,
    DeliveryAttempt,
    Notification,
    Outbox,
    Preference,
    SignalRow,
    bootstrap,
    instant,
    now_ms,
    transaction,
)

DEFAULTS = {
    "quiet_enabled": False,
    "quiet_start": "23:00",
    "quiet_end": "07:00",
    "timezone": "Asia/Shanghai",
    "priority": 5,
    "repeat_seconds": 30,
    "ring_seconds": 15,
    "max_repeats": 0,
    "mode": "ntfy_native",
}


def quiet_until(moment: datetime, config: dict):
    if not config["quiet_enabled"]:
        return None
    local = moment.astimezone(ZoneInfo(config["timezone"]))
    sh, sm = map(int, config["quiet_start"].split(":"))
    eh, em = map(int, config["quiet_end"].split(":"))
    start = local.replace(hour=sh, minute=sm, second=0, microsecond=0)
    end = local.replace(hour=eh, minute=em, second=0, microsecond=0)
    if end <= start:
        if local < end:
            start -= timedelta(days=1)
        else:
            end += timedelta(days=1)
    return end if start <= local < end else None


def claim():
    if not settings.ntfy_topic:
        return None
    now = now_ms()
    with transaction() as db:
        eligible = (Outbox.next_at <= now) & or_(
            Outbox.status == "pending", (Outbox.status == "sending") & (Outbox.lease_until < now)
        )
        candidate = db.execute(
            select(Outbox.id, Outbox.notification_id)
            .join(Notification, Notification.id == Outbox.notification_id)
            .outerjoin(SignalRow, SignalRow.id == Notification.signal_id)
            .where(eligible, or_(
                Notification.kind == "test",
                (Notification.kind == "system") & settings.delivery_enabled,
                (Notification.kind == "signal") & settings.delivery_enabled
                & SignalRow.chart_alert_id.is_not(None) & SignalRow.watch_id.is_(None),
            ))
            .order_by(Outbox.next_at)
            .limit(1)
        ).first()
        if not candidate:
            return None
        # All state transitions lock notification before outbox, including confirmation.
        note = db.scalar(
            select(Notification)
            .where(Notification.id == candidate.notification_id)
            .with_for_update(skip_locked=True)
        )
        if not note:
            return None
        row = db.scalar(
            select(Outbox)
            .where(Outbox.id == candidate.id, eligible)
            .with_for_update(skip_locked=True)
        )
        if not row:
            return None
        signal = db.get(SignalRow, note.signal_id) if note.signal_id else None
        if note.ack_at or note.status == "retired" or (
            note.kind == "signal" and (not signal or not current_signal(signal))
        ):
            row.status = "cancelled"
            return None
        pref = db.get(Preference, "notifications")
        config = {**DEFAULTS, **(pref.value if pref else {})}
        quiet_end = quiet_until(instant(now), config)
        if quiet_end:
            row.next_at = int(quiet_end.timestamp() * 1000)
            note.status = "quiet"
            return None
        token = secrets.token_urlsafe(32)
        # Keep attempt-scoped hashes: an earlier accepted request may have timed out.
        # Its confirmation button must remain usable even after a retry.
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        note.ack_hash = token_hash
        if note.kind == "test":
            test_id = note.payload["test_id"]
            pref = db.get(Preference, "test_notification:" + test_id)
            if not pref:
                row.status = "cancelled"
                return None
            hashes = list(pref.value.get("token_hashes", []))
            if token_hash not in hashes:
                hashes.append(token_hash)
            pref.value = {**pref.value, "token_hash": token_hash,
                          "token_hashes": hashes, "expires": now + 86400000}
            ack_url = f"{settings.public_url}/api/notification-tests/{test_id}/ack"
            ack_label = "确认测试"
        else:
            db.add(AckGrant(token_hash=token_hash, notification_id=note.id))
            ack_url = f"{settings.public_url}/api/notification-actions/{note.id}/ack"
            ack_label = "确认"
        row.status = "sending"
        row.lease_until = now + 60_000
        row.attempts += 1
        if note.kind == "signal":
            occurred = instant(signal.occurred_at).astimezone(ZoneInfo("Asia/Shanghai")).isoformat()
            title = signal_title(signal)
            message = signal_message(signal) if signal.evidence.get("chart_alert") else f"价格 {signal.price} / 阈值 {signal.threshold}\n发生时间 {occurred}\n信号 {signal.id}\n请使用“确认”停止后续提醒。"
            click = f"{settings.public_url}/advanced-charts?panel=notifications&signal={signal.id}"
        else:
            title = note.payload.get("title", "守望运行通知")
            message = note.payload.get("message", "")
            click = settings.public_url + "/settings"
        body = {
            "topic": settings.ntfy_topic,
            "title": title,
            "message": message,
            "priority": 1 if config["mode"] == "companion" else config["priority"],
            "click": click,
            "actions": [
                {
                    "action": "http",
                    "label": ack_label,
                    "url": ack_url,
                    "method": "POST",
                    "headers": {"Authorization": f"Bearer {token}"},
                    "clear": True,
                }
            ],
        }
        return row.id, note.id, body, row.attempts


def deliver_once(client=None):
    task = claim()
    if task is None:
        return False
    task_id, note_id, body, attempt = task
    headers = {"Authorization": f"Bearer {settings.ntfy_token}"} if settings.ntfy_token else {}
    accepted, detail = False, {}
    try:
        with httpx.Client(timeout=15) if client is None else _Existing(client) as transport:
            response = transport.post(settings.ntfy_url.rstrip("/"), json=body, headers=headers)
            response.raise_for_status()
            detail = {"provider_id": response.json().get("id")}
            accepted = True
    except (httpx.HTTPError, ValueError) as e:
        detail = {"error": type(e).__name__}
        if isinstance(e, httpx.HTTPStatusError):
            detail["status_code"] = e.response.status_code
    with transaction() as db:
        # Same lock order as acknowledge: notification before its outbox row.
        note = db.scalar(select(Notification).where(Notification.id == note_id).with_for_update())
        row = db.scalar(select(Outbox).where(Outbox.id == task_id).with_for_update())
        db.add(
            DeliveryAttempt(
                notification_id=note_id,
                status="accepted" if accepted else "failed_or_unknown",
                details=detail,
            )
        )
        if row.attempts != attempt:
            # Record the HTTP outcome, but a newer lease owns task state.
            return True
        row.lease_until = None
        signal = db.get(SignalRow, note.signal_id) if note.signal_id else None
        if note.ack_at or note.status == "retired" or row.status == "cancelled" or (
            note.kind == "signal" and (not signal or not current_signal(signal))
        ):
            row.status = "cancelled"
        elif accepted:
            row.status = "accepted"
            row.provider_id = detail.get("provider_id")
            note.status = "server_accepted"
            if note.kind == "test":
                db.add(Audit(kind="notification_test_accepted",
                             details={"test_id": note.payload["test_id"]}))
        else:
            row.error = str(detail)
            row.status = "blocked" if detail.get("status_code") in (401, 403) else "pending"
            row.next_at = now_ms() + min(300, 2 ** min(row.attempts, 8)) * 1000
            note.status = "delivery_error"
            if note.kind == "test":
                db.add(Audit(kind="notification_test_failed_or_unknown",
                             details={"test_id": note.payload["test_id"]}))
    return True


class _Existing:
    def __init__(self, client):
        self.client = client

    def __enter__(self):
        return self.client

    def __exit__(self, *args):
        return False


def run(stop, client=None):
    last = 0
    owned_client = client is None
    client = client or httpx.Client(timeout=15)
    try:
        while not stop.is_set():
            error = None
            try:
                deliver_once(client)
                if now_ms() - last > 60_000:
                    with transaction() as db:
                        db.add(Audit(kind="notify_heartbeat", details={}))
                    last = now_ms()
            except Exception as exc:
                error = exc
                import logging

                logging.getLogger(__name__).exception("Notification delivery loop failed")
            from .runtime_health import progress

            progress(error=error)
            stop.wait(2)
    finally:
        if owned_client:
            client.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    bootstrap()
    if args.once:
        deliver_once()
        return
    stopped = threading.Event()
    run(stopped)


if __name__ == "__main__":
    main()
