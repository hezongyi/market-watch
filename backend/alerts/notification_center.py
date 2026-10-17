"""Unified notification center (Issue #75).

Reliable source projection, append-only change log, idempotent observations.
Legacy notification/outbox/receipt rows remain the source evidence; this module
never rewrites them.

Contract: docs/unified-notification-center-contract-20261017.md
"""

from __future__ import annotations

import base64
import hashlib
import json
from datetime import UTC, datetime

from sqlalchemy import String, and_, cast, exists, func, or_, select
from sqlalchemy.exc import IntegrityError

from .config import settings
from .storage import (
    Audit,
    Instrument,
    Notification,
    NotificationChange,
    NotificationEvent,
    NotificationIncident,
    NotificationObservation,
    NotificationSourceClaim,
    NotificationStream,
    SignalRow,
    now_ms,
    transaction,
    uid,
)

SUBJECT = "owner"
MAX_EVENT_BYTES = 16 * 1024
PAGE_DEFAULT = 100
PAGE_MAX = 500
RATE_PER_MINUTE = 60
RATE_BURST = 120
RETENTION_EVENT_MS = 30 * 24 * 3600 * 1000
RETENTION_CHANGE_MS = 7 * 24 * 3600 * 1000
SEVERITIES = ("info", "warning", "critical")
EVENT_KINDS = ("alert", "failure", "operation", "success")
AUTO_KINDS = ("received", "rendered")
EXPLICIT_KINDS = ("viewed", "handled", "phone_stop")
SOUND_KINDS = (
    "sound_blocked",
    "sound_suppressed",
    "sound_expired",
    "sound_reserved",
    "sound_started",
    "sound_failed",
    "sound_unknown",
)
CHANGE_KINDS = ("created", "updated", "incident", "observation", "deleted")
SOURCE_AUDITS = {
    "signal": "signal",
    "chart_alert_signal": "chart_alert",
    "notification_delivery": "delivery",
    "notification_receipt": "receipt",
}


class NotificationConflict(ValueError):
    """Client payload conflicts with an existing event id."""


class NotificationReset(ValueError):
    """Cursor/epoch cannot be resumed; the client must rebuild its baseline."""


def _iso(ms_value: int | None):
    if not ms_value:
        return None
    return datetime.fromtimestamp(ms_value / 1000, UTC).isoformat()


def stream_row(db, *, lock: bool = False) -> NotificationStream:
    query = select(NotificationStream).where(NotificationStream.id == 1)
    if lock:
        query = query.with_for_update()
    row = db.scalar(query)
    if row is None:
        row = NotificationStream(id=1, epoch=uid(), seq=0)
        db.add(row)
        db.flush()
    return row


def _allocate(db) -> tuple[str, int]:
    """Allocate the next change sequence inside the caller's transaction."""
    stream = stream_row(db, lock=True)
    stream.seq += 1
    stream.updated_at = now_ms()
    db.flush()
    return stream.epoch, stream.seq


def event_dict(event: NotificationEvent, *, epoch: str | None = None) -> dict:
    return {
        "schema_version": event.schema_version,
        "id": event.id,
        "epoch": epoch,
        "source": {
            "kind": event.source_kind,
            "id": event.source_id,
            "version": event.source_version,
        },
        "kind": event.kind,
        "severity": event.severity,
        "title": event.title,
        "summary": event.summary,
        "context": event.context or {},
        "links": event.links or {},
        "actions": event.actions or {},
        "evidence": event.evidence or {},
        "dedupe_key": event.dedupe_key,
        "incident_id": event.incident_id,
        "notification_id": event.notification_id,
        "notify_web": event.notify_web,
        "occurred_at": event.occurred_at,
        "recorded_at": event.recorded_at,
        "first_seq": event.first_seq,
        "version": event.version,
        "deleted_at": event.deleted_at,
    }


def incident_dict(incident: NotificationIncident) -> dict:
    return {
        "id": incident.id,
        "dedupe_key": incident.dedupe_key,
        "status": incident.status,
        "severity": incident.severity,
        "count": incident.count,
        "first_at": incident.first_at,
        "last_at": incident.last_at,
        "resolved_at": incident.resolved_at,
        "attention_version": incident.attention_version,
    }


def _publish(db, kind: str, *, event: NotificationEvent | None = None,
             incident: NotificationIncident | None = None, at: int | None = None,
             extra: dict | None = None) -> int:
    epoch, seq = _allocate(db)
    payload = {"epoch": epoch, "seq": seq, "type": kind, "at": at or now_ms()}
    if event is not None:
        payload["event"] = event_dict(event, epoch=epoch)
    if incident is not None:
        payload["incident"] = incident_dict(incident)
    if extra:
        payload.update(extra)
    db.add(NotificationChange(
        seq=seq, epoch=epoch, kind=kind,
        event_id=event.id if event else None,
        incident_id=incident.id if incident else None,
        version=event.version if event else 1,
        at=at or now_ms(), payload=payload,
    ))
    db.flush()
    return seq


def _claim(db, audit_id: int, seq: int = 0) -> None:
    db.add(NotificationSourceClaim(
        source_kind="audit", source_id=str(audit_id), source_version="1",
        change_seq=seq, claimed_at=now_ms(),
    ))
    db.flush()


def _claimed(db, audit_id: int) -> bool:
    return db.scalar(select(NotificationSourceClaim.id).where(
        NotificationSourceClaim.source_kind == "audit",
        NotificationSourceClaim.source_id == str(audit_id),
        NotificationSourceClaim.source_version == "1",
    )) is not None


def pending_audits(db, limit: int = 100) -> list[int]:
    claim = NotificationSourceClaim
    query = (
        select(Audit.id)
        .where(Audit.kind.in_(tuple(SOURCE_AUDITS)))
        .where(~exists().where(and_(
            claim.source_kind == "audit",
            claim.source_id == cast(Audit.id, String),
            claim.source_version == "1",
        )))
        .order_by(Audit.id)
        .limit(limit)
    )
    return list(db.scalars(query))


def _instrument_label(db, instrument_id: str | None) -> str | None:
    if not instrument_id:
        return None
    row = db.get(Instrument, instrument_id)
    return row.label if row else instrument_id


def _incident_for(db, dedupe_key: str, severity: str, occurred_at: int) -> tuple[NotificationIncident, bool]:
    incident = db.scalar(select(NotificationIncident).where(
        NotificationIncident.subject == SUBJECT,
        NotificationIncident.dedupe_key == dedupe_key,
        NotificationIncident.status == "open",
    ))
    if incident is None:
        incident = NotificationIncident(
            subject=SUBJECT, dedupe_key=dedupe_key, status="open", severity=severity,
            count=1, first_at=occurred_at, last_at=occurred_at, attention_version=1,
            created_at=now_ms(), updated_at=now_ms(),
        )
        db.add(incident)
        db.flush()
        return incident, True
    incident.count += 1
    incident.last_at = max(incident.last_at, occurred_at)
    incident.status = "open"
    incident.resolved_at = None
    incident.attention_version += 1
    incident.severity = severity
    incident.updated_at = now_ms()
    db.flush()
    return incident, False


def _signal_payload(signal: SignalRow, notification: Notification | None) -> dict:
    evidence = signal.evidence or {}
    chart_alert = bool(evidence.get("chart_alert"))
    config = evidence.get("config") or {}
    identity = evidence.get("market_identity") or {}
    symbol = identity.get("symbol") or signal.instrument_id
    timeframe = config.get("timeframe")
    rule_version = evidence.get("rule_version") or evidence.get("rule", {}).get("version")
    alert_id = evidence.get("alert_id")
    context = {
        "instrument": signal.instrument_id,
        "symbol": symbol,
        "timeframe": timeframe,
        "source": identity.get("source") or evidence.get("source"),
        "direction": signal.direction,
        "price": str(signal.price),
        "threshold": str(signal.threshold),
        "reason": signal.reason,
        "rule_version": rule_version,
        "alert_id": alert_id,
        "watch_id": signal.watch_id,
        "run": evidence.get("run"),
        "ordinal": evidence.get("ordinal"),
        "late": bool(evidence.get("late")),
        "detected_at": evidence.get("detected_at"),
        "notification_id": notification.id if notification else None,
        "notify_web": bool(config.get("notify_web", True)),
        "notify_ntfy": bool(config.get("notify_ntfy", True)),
        "channels": [],
    }
    dedupe = f"chart-alert:{alert_id}" if chart_alert and alert_id else (
        f"watch:{signal.watch_id}" if signal.watch_id else f"signal:{signal.id}")
    title = f"{symbol} · {signal.reason}"
    summary = f"{signal.direction} · 价格 {signal.price} / 阈值 {signal.threshold}"
    return {
        "id": f"srv:{signal.id}",
        "source_kind": "chart_alert" if chart_alert else "signal",
        "source_id": signal.id,
        "source_version": "1",
        "kind": "alert",
        "severity": "warning",
        # notify_web=false still keeps the event searchable; it only suppresses
        # the immediate bubble/sound candidate on the client.
        "notify_web": context["notify_web"],
        "title": title,
        "summary": summary,
        "context": context,
        "links": {
            "signal_id": signal.id,
            **({"alert_id": alert_id} if alert_id else {}),
            **({"watch_id": signal.watch_id} if signal.watch_id else {}),
        },
        "actions": {
            "view": True,
            "handled": True,
            "phone_stop": bool(notification is not None),
        },
        "evidence": {
            "price": str(signal.price),
            "threshold": str(signal.threshold),
            "unit": evidence.get("unit"),
            "rule_version": rule_version,
            "observation_id": evidence.get("observation_id"),
            "chart_generation": evidence.get("run"),
        },
        "dedupe_key": dedupe,
        "occurred_at": signal.occurred_at,
        "instrument": signal.instrument_id,
        "workspace": chart_alert and f"chart:{alert_id}" or None,
        "notification_id": notification.id if notification else None,
    }


def _project_event(db, payload: dict, recorded_at: int | None = None) -> tuple[NotificationEvent, NotificationIncident | None, bool]:
    event = db.scalar(select(NotificationEvent).where(
        NotificationEvent.id == payload["id"]))
    occurred_at = int(payload["occurred_at"])
    if event is not None:
        # Replayed source: refresh mutable channel context only. A retry must not
        # increment the incident count, bump attention or append a change.
        merged = {**(event.context or {}), **payload["context"]}
        incident = db.get(NotificationIncident, event.incident_id) if event.incident_id else None
        if merged != (event.context or {}):
            event.context = merged
            event.version += 1
            db.flush()
        return event, incident, False
    incident, created_incident = _incident_for(
        db, payload["dedupe_key"], payload["severity"], occurred_at)
    event = NotificationEvent(
        id=payload["id"], subject=SUBJECT,
        source_kind=payload["source_kind"], source_id=payload["source_id"],
        source_version=payload["source_version"],
        kind=payload["kind"], severity=payload["severity"],
        title=payload["title"][:300], summary=(payload["summary"] or "")[:2000],
        context=payload["context"], links=payload["links"], actions=payload["actions"],
        evidence=payload["evidence"], dedupe_key=payload["dedupe_key"],
        incident_id=incident.id, notification_id=payload.get("notification_id"),
        notify_web=payload["notify_web"], occurred_at=occurred_at,
        recorded_at=recorded_at or now_ms(), version=1,
        instrument=payload.get("instrument"), workspace=payload.get("workspace"),
    )
    db.add(event)
    db.flush()
    return event, incident, True


def _project_signal(db, audit: Audit) -> int | None:
    details = audit.details or {}
    signal = db.get(SignalRow, details.get("signal_id")) if details.get("signal_id") else None
    if signal is None:
        return None
    notification = db.scalar(select(Notification).where(Notification.signal_id == signal.id))
    payload = _signal_payload(signal, notification)
    event, incident, created = _project_event(db, payload, audit.at)
    if not created:
        return 0  # already projected; keep the claim so replays stay idempotent
    event.first_seq = 0
    seq = _publish(db, "created", event=event, incident=incident)
    event.first_seq = seq
    db.flush()
    return seq


def _delivery_fact(db, audit: Audit) -> int | None:
    details = audit.details or {}
    notification_id = details.get("notification_id")
    if not notification_id:
        return False
    event = db.scalar(select(NotificationEvent).where(
        NotificationEvent.notification_id == notification_id))
    if event is None:
        return None  # Signal projection has not committed yet; retry later.
    channels = list((event.context or {}).get("channels") or [])
    if details.get("kind") == "receipt":
        fact = {"channel": "device", "status": "received",
                "at": details.get("received_at"), "device": details.get("device_id")}
    else:
        fact = {"channel": "ntfy", "status": details.get("status"),
                "at": details.get("at") or audit.at,
                "attempt_id": details.get("attempt_id"),
                "error": details.get("error")}
    channels = [row for row in channels
                if not (row.get("channel") == fact["channel"]
                        and row.get("attempt_id") == fact.get("attempt_id"))]
    channels.append(fact)
    event.context = {**event.context, "channels": channels[-20:]}
    event.version += 1
    db.flush()
    return _publish(db, "updated", event=event)


def project_pending(limit: int = 100) -> int:
    """Project committed source audits. Safe to run concurrently or after a crash."""
    with transaction() as db:
        ids = pending_audits(db, limit)
    projected = 0
    for audit_id in ids:
        try:
            with transaction() as db:
                if _claimed(db, audit_id):
                    continue
                audit = db.get(Audit, audit_id)
                if audit is None:
                    continue
                if audit.kind in ("signal", "chart_alert_signal"):
                    seq = _project_signal(db, audit)
                else:
                    seq = _delivery_fact(db, audit)
                if seq is None:
                    continue
                _claim(db, audit_id, seq)
                projected += 1
        except IntegrityError:
            # Another projector won the claim; its transaction is authoritative.
            continue
    return projected


# --- Browser events ----------------------------------------------------------

def _canonical(payload: dict) -> str:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _payload_hash(payload: dict) -> str:
    return hashlib.sha256(_canonical({
        "title": payload.get("title"),
        "summary": payload.get("summary"),
        "kind": payload.get("kind"),
        "severity": payload.get("severity"),
        "context": payload.get("context") or {},
        "occurred_at": payload.get("occurred_at"),
    }).encode()).hexdigest()


def _rate_ok(db) -> int | None:
    now = now_ms()
    minute_limit = settings.notification_rate_minute
    burst_limit = settings.notification_rate_burst
    if minute_limit <= 0:
        return None
    minute = db.scalar(select(func.count()).select_from(NotificationEvent).where(
        NotificationEvent.subject == SUBJECT,
        NotificationEvent.source_kind == "browser",
        NotificationEvent.recorded_at > now - 60_000,
    )) or 0
    if minute >= minute_limit:
        return 60
    burst = db.scalar(select(func.count()).select_from(NotificationEvent).where(
        NotificationEvent.subject == SUBJECT,
        NotificationEvent.source_kind == "browser",
        NotificationEvent.recorded_at > now - 120_000,
    )) or 0
    if burst_limit > 0 and burst >= burst_limit:
        return 60
    return None


def record_browser_event(payload: dict) -> dict:
    event_id = str(payload.get("id") or "")
    if not event_id.startswith("web:") or len(event_id) > 80:
        raise ValueError("浏览器事件 ID 必须以 web: 开头")
    raw = _canonical(payload)
    if len(raw.encode()) > MAX_EVENT_BYTES:
        raise ValueError("通知超过 16 KiB 预算，请精简后重试")
    kind = payload.get("kind") or "failure"
    severity = payload.get("severity") or "warning"
    if kind not in EVENT_KINDS or severity not in SEVERITIES:
        raise ValueError("未知的通知类型或级别")
    digest = _payload_hash(payload)
    context = payload.get("context") or {}
    occurred = int(payload.get("occurred_at") or now_ms())
    now = now_ms()
    occurred = min(max(occurred, now - 3600_000), now + 60_000)
    dedupe = str(payload.get("dedupe_key") or f"browser:{digest[:16]}")[:200]
    with transaction() as db:
        # Serialize intake so two browsers with the same dedupe key cannot race
        # the incident upsert into a unique violation (PostgreSQL row lock).
        stream_row(db, lock=True)
        existing = db.get(NotificationEvent, event_id)
        if existing is not None:
            if existing.subject != SUBJECT or existing.payload_hash != digest:
                raise NotificationConflict("相同事件 ID 的负载不一致")
            return event_dict(existing), False
        retry = _rate_ok(db)
        if retry is not None:
            raise PermissionError(f"通知上报过于频繁，请 {retry} 秒后重试")
        incident, created_incident = _incident_for(db, dedupe, severity, occurred)
        event = NotificationEvent(
            id=event_id, subject=SUBJECT, source_kind="browser", source_id=event_id,
            source_version="1", kind=kind, severity=severity,
            title=str(payload.get("title") or "浏览器通知")[:300],
            summary=str(payload.get("summary") or "")[:2000],
            context={**context, "profile_id": payload.get("profile_id")},
            links=payload.get("links") or {}, actions=payload.get("actions") or {},
            evidence=payload.get("evidence") or {}, payload_hash=digest,
            dedupe_key=dedupe, incident_id=incident.id,
            notification_id=None, notify_web=bool(payload.get("notify_web", True)),
            occurred_at=occurred, recorded_at=now, version=1,
            instrument=context.get("instrument"), workspace=context.get("workspace"),
        )
        db.add(event)
        db.flush()
        if created_incident:
            _publish(db, "incident", incident=incident)
        seq = _publish(db, "created", event=event, incident=incident)
        event.first_seq = seq
        db.flush()
        return event_dict(event), True


# --- Reads -------------------------------------------------------------------

def _encode_cursor(event: NotificationEvent) -> str:
    raw = f"{event.occurred_at}|{event.id}".encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode_cursor(value: str | None) -> tuple[int, str] | None:
    if not value:
        return None
    try:
        raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)).decode()
        at, event_id = raw.split("|", 1)
        return int(at), event_id
    except (ValueError, UnicodeDecodeError):
        raise ValueError("分页游标无效")


def change_window(db) -> dict:
    stream = stream_row(db)
    minimum = db.scalar(select(func.min(NotificationChange.seq)))
    return {"epoch": stream.epoch, "seq": stream.seq,
            "min_seq": minimum if minimum is not None else stream.seq + 1}


def list_events(db, *, limit: int = PAGE_DEFAULT, before: str | None = None,
                kinds: list[str] | None = None, severities: list[str] | None = None,
                status: str | None = None, query: str | None = None,
                instrument: str | None = None, workspace: str | None = None) -> dict:
    limit = max(1, min(int(limit or PAGE_DEFAULT), PAGE_MAX))
    stream = stream_row(db)
    high = stream.seq
    q = select(NotificationEvent).where(
        NotificationEvent.subject == SUBJECT,
        NotificationEvent.deleted_at.is_(None),
        NotificationEvent.first_seq <= high,
    )
    if kinds:
        q = q.where(NotificationEvent.kind.in_(kinds))
    if severities:
        q = q.where(NotificationEvent.severity.in_(severities))
    if instrument:
        q = q.where(NotificationEvent.instrument == instrument)
    if workspace:
        q = q.where(NotificationEvent.workspace == workspace)
    if status and status != "all":
        incidents = select(NotificationIncident.id).where(
            NotificationIncident.subject == SUBJECT,
            NotificationIncident.status == status)
        q = q.where(NotificationEvent.incident_id.in_(incidents))
    if query:
        like = f"%{query}%"
        q = q.where(or_(NotificationEvent.title.like(like),
                        NotificationEvent.summary.like(like)))
    cursor = _decode_cursor(before)
    if cursor:
        at, event_id = cursor
        q = q.where(or_(NotificationEvent.occurred_at < at,
                        and_(NotificationEvent.occurred_at == at,
                             NotificationEvent.id < event_id)))
    rows = list(db.scalars(
        q.order_by(NotificationEvent.occurred_at.desc(),
                   NotificationEvent.id.desc()).limit(limit + 1)))
    more = len(rows) > limit
    rows = rows[:limit]
    read_ids = set(db.scalars(
        select(NotificationObservation.event_id).where(
            NotificationObservation.subject == SUBJECT,
            NotificationObservation.kind == "viewed",
            NotificationObservation.event_id.in_([r.id for r in rows] or [""]),
        )))
    incidents = {}
    if rows:
        incidents = {row.id: row for row in db.scalars(
            select(NotificationIncident).where(
                NotificationIncident.id.in_({r.incident_id for r in rows if r.incident_id})))}
    unread = db.scalar(select(func.count()).select_from(NotificationEvent).where(
        NotificationEvent.subject == SUBJECT,
        NotificationEvent.deleted_at.is_(None),
        NotificationEvent.first_seq <= high,
        ~exists().where(and_(
            NotificationObservation.subject == SUBJECT,
            NotificationObservation.kind == "viewed",
            NotificationObservation.event_id == NotificationEvent.id,
        )),
    )) or 0
    return {
        "epoch": stream.epoch,
        "high_watermark": high,
        "items": [{**event_dict(r, epoch=stream.epoch), "read": r.id in read_ids,
                   "incident": incident_dict(incidents[r.incident_id])
                   if r.incident_id in incidents else None}
                  for r in rows],
        "next_before": _encode_cursor(rows[-1]) if more and rows else None,
        "unread": unread,
    }


def event_detail(db, event_id: str) -> dict:
    event = db.get(NotificationEvent, event_id)
    if event is None or event.subject != SUBJECT:
        raise KeyError("通知不存在")
    stream = stream_row(db)
    observations = list(db.scalars(
        select(NotificationObservation).where(
            NotificationObservation.event_id == event_id)
        .order_by(NotificationObservation.server_at)))
    incident = db.get(NotificationIncident, event.incident_id) if event.incident_id else None
    return {
        "event": event_dict(event, epoch=stream.epoch),
        "incident": incident_dict(incident) if incident else None,
        "observations": [observation_dict(row) for row in observations],
    }


def observation_dict(row: NotificationObservation) -> dict:
    return {
        "id": row.id, "event_id": row.event_id, "kind": row.kind,
        "result": row.result, "profile_id": row.profile_id,
        "client_at": row.client_at, "server_at": row.server_at,
        "client_at_iso": _iso(row.client_at), "server_at_iso": _iso(row.server_at),
        "meta": row.meta or {},
    }


def add_observation(db, *, event_id: str, kind: str, profile_id: str = "",
                    client_at: int | None = None, dedupe: str = "",
                    result: str | None = None, meta: dict | None = None) -> tuple[dict, bool]:
    if kind not in AUTO_KINDS + EXPLICIT_KINDS + SOUND_KINDS:
        raise ValueError("未知的观察类型")
    event = db.get(NotificationEvent, event_id)
    if event is None or event.subject != SUBJECT:
        raise KeyError("通知不存在")
    existing = db.scalar(select(NotificationObservation).where(
        NotificationObservation.subject == SUBJECT,
        NotificationObservation.event_id == event_id,
        NotificationObservation.kind == kind,
        NotificationObservation.profile_id == profile_id,
        NotificationObservation.dedupe == dedupe,
    ))
    if existing is not None:
        return observation_dict(existing), False
    if kind == "sound_reserved":
        prior = db.scalar(select(NotificationObservation).where(
            NotificationObservation.subject == SUBJECT,
            NotificationObservation.event_id == event_id,
            NotificationObservation.kind == "sound_reserved",
            NotificationObservation.profile_id == profile_id,
        ))
        if prior is not None:
            raise NotificationConflict("该事件的声音自动尝试已预留")
    if kind == "phone_stop" and event.notification_id:
        from .service import acknowledge

        acknowledge(db, event.notification_id)
        event.context = {**(event.context or {}),
                         "phone_stopped_at": now_ms()}
        event.version += 1
        db.flush()
        _publish(db, "updated", event=event)
    row = NotificationObservation(
        id=uid(), subject=SUBJECT, event_id=event_id, profile_id=profile_id[:80],
        kind=kind, result=(result or "recorded")[:32], dedupe=dedupe[:120],
        client_at=client_at, server_at=now_ms(), meta=meta or {},
    )
    db.add(row)
    db.flush()
    _publish(db, "observation", event=event, extra={"observation": observation_dict(row)})
    return observation_dict(row), True


def changes_since(db, after_seq: int, *, epoch: str | None = None, limit: int = 100) -> dict:
    limit = max(1, min(int(limit or 100), PAGE_MAX))
    stream = stream_row(db)
    minimum = db.scalar(select(func.min(NotificationChange.seq)))
    if epoch and epoch != stream.epoch:
        return {"reset": True, "reason": "epoch", "epoch": stream.epoch,
                "seq": stream.seq, "items": []}
    expired = (minimum is None and after_seq < stream.seq) or (
        minimum is not None and after_seq + 1 < minimum)
    if after_seq < 0 or expired:
        return {"reset": True, "reason": "expired", "epoch": stream.epoch,
                "seq": stream.seq, "items": []}
    rows = list(db.scalars(
        select(NotificationChange).where(NotificationChange.seq > after_seq)
        .order_by(NotificationChange.seq).limit(limit)))
    return {
        "reset": False,
        "epoch": stream.epoch,
        "seq": stream.seq,
        "items": [row.payload for row in rows],
        "next_seq": rows[-1].seq if rows else after_seq,
        "more": bool(rows) and rows[-1].seq < stream.seq,
    }


def resolve_incident(db, incident_id: str) -> dict:
    incident = db.get(NotificationIncident, incident_id)
    if incident is None or incident.subject != SUBJECT:
        raise KeyError("事故不存在")
    if incident.status != "resolved":
        incident.status = "resolved"
        incident.resolved_at = now_ms()
        incident.updated_at = incident.resolved_at
        db.flush()
        _publish(db, "incident", incident=incident)
    return incident_dict(incident)


def prune(now: int | None = None) -> dict:
    """Retention: tombstones first, then delete. Clients that lose history get reset."""
    now = now or now_ms()
    removed_events = 0
    with transaction() as db:
        expired = list(db.scalars(select(NotificationEvent).where(
            NotificationEvent.occurred_at < now - RETENTION_EVENT_MS,
            NotificationEvent.deleted_at.is_(None)).limit(500)))
        for event in expired:
            event.deleted_at = now
            db.flush()
            _publish(db, "deleted", event=event, at=now)
            removed_events += 1
    with transaction() as db:
        old = list(db.scalars(select(NotificationEvent.id).where(
            NotificationEvent.occurred_at < now - RETENTION_EVENT_MS - 3600_000,
            NotificationEvent.deleted_at.is_not(None)).limit(500)))
        for event_id in old:
            event = db.get(NotificationEvent, event_id)
            if event:
                db.delete(event)
    with transaction() as db:
        changes = list(db.scalars(select(NotificationChange.seq).where(
            NotificationChange.at < now - RETENTION_CHANGE_MS).limit(2000)))
        if changes:
            db.query(NotificationChange).filter(
                NotificationChange.seq.in_(changes)).delete(synchronize_session=False)
    return {"events": removed_events}
