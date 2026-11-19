"""Daily briefing persistence. Transactions never contain provider network I/O."""

import uuid
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import and_, or_, select

from .chart_series import decode, encode
from .storage import AdvancedPreference, BriefingPlan, BriefingReport, Notification, Outbox, now_ms

PLAN_ID = "daily-morning"
ZONE = ZoneInfo("Asia/Shanghai")
PUBLISHED = {"ready", "partial", "failed", "skipped"}


class Conflict(ValueError):
    pass


def next_run(at):
    local = datetime.fromtimestamp(at / 1000, ZONE)
    target = local.replace(hour=8, minute=0, second=0, microsecond=0)
    if target <= local:
        target += timedelta(days=1)
    return int(target.timestamp() * 1000)


def groups(db):
    row = db.scalar(
        select(AdvancedPreference).where(
            AdvancedPreference.kind == "setting",
            AdvancedPreference.name == "mw.watchlists.v1",
            AdvancedPreference.tool == "",
        )
    )
    lists = row.content.get("value", {}).get("lists", []) if row else []
    return lists, row.revision if row else None


def plan_view(db):
    plan = db.get(BriefingPlan, PLAN_ID)
    lists, _ = groups(db)
    from .notification_transport import transport_config

    transport = transport_config(db)
    return {
        "enabled": plan.enabled if plan else False,
        "group_ids": plan.group_ids if plan else [],
        "revision": plan.revision if plan else 0,
        "next_run_at": plan.next_run_at if plan else None,
        "timezone": "Asia/Shanghai",
        "local_time": "08:00",
        "groups": [{"id": x["id"], "title": x["title"]} for x in lists],
        "phone_available": bool(transport["enabled"] and transport["topic"]),
    }


def save_plan(db, *, enabled, group_ids, revision, at=None):
    at = now_ms() if at is None else at
    plan = db.scalar(select(BriefingPlan).where(BriefingPlan.id == PLAN_ID).with_for_update())
    if (plan.revision if plan else 0) != revision:
        raise Conflict("简报设置已在其他窗口修改，请重新读取后保存")
    lists, _ = groups(db)
    ids = list(dict.fromkeys(group_ids))
    if enabled and not ids:
        raise ValueError("请选择自选分组")
    if set(ids) - {x["id"] for x in lists}:
        raise ValueError("所选分组已删除，请重新选择")
    if not plan:
        plan = BriefingPlan(
            id=PLAN_ID, enabled=False, group_ids=[], revision=0, created_at=at, updated_at=at
        )
        db.add(plan)
    if enabled and not plan.enabled:
        plan.next_run_at = next_run(at)
    if not enabled:
        plan.next_run_at = None
        # Serialize with delivery using notification -> outbox lock order.
        notes = db.scalars(
            select(Notification)
            .join(BriefingReport, BriefingReport.notification_id == Notification.id)
            .where(BriefingReport.plan_id == PLAN_ID, Notification.kind == "briefing")
            .with_for_update(of=Notification)
        ).all()
        for note in notes:
            outbox = db.scalar(
                select(Outbox).where(Outbox.notification_id == note.id).with_for_update()
            )
            if outbox and outbox.status == "pending":
                outbox.status, note.status = "cancelled", "recorded"
    plan.enabled, plan.group_ids, plan.revision, plan.updated_at = enabled, ids, revision + 1, at
    db.flush()
    return plan_view(db)


def freeze(db, plan):
    lists, revision = groups(db)
    chosen = [x for x in lists if x["id"] in plan.group_ids]
    missing = sorted(set(plan.group_ids) - {x["id"] for x in chosen})
    members, seen, invalid = [], set(), []
    for group in chosen:
        for ticker in group.get("symbols", []):
            try:
                ident, kind = decode(ticker)
                canonical = encode(ident, kind)
            except (ValueError, TypeError):
                invalid.append(str(ticker)[:100])
                continue
            if canonical not in seen:
                seen.add(canonical)
                members.append(canonical)
    return {
        "schema_version": 1,
        "plan_revision": plan.revision,
        "group_revision": revision,
        "groups": [{"id": x["id"], "title": x["title"]} for x in chosen],
        "missing_groups": missing,
        "invalid_members": invalid,
        "members": members,
        "sections": [{"id": "daily_change", "version": 1, "parameters": {}}],
    }


def preview(db, request_id, *, at=None):
    at = now_ms() if at is None else at
    existing = db.get(BriefingReport, request_id)
    if existing:
        if existing.mode != "preview":
            raise ValueError("请求标识已被使用")
        return report_view(db, existing)
    plan = db.scalar(select(BriefingPlan).where(BriefingPlan.id == PLAN_ID).with_for_update())
    existing = db.get(BriefingReport, request_id)
    if existing:
        return report_view(db, existing)
    if not plan or not plan.group_ids:
        raise ValueError("先保存需要观察的自选分组")
    row = BriefingReport(
        id=request_id,
        plan_id=plan.id,
        mode="preview",
        cutoff_at=at,
        snapshot=freeze(db, plan),
        status="pending",
        body={},
        created_at=at,
    )
    db.add(row)
    db.flush()
    return report_view(db, row)


def due(db, *, at):
    plan = db.scalar(
        select(BriefingPlan).where(BriefingPlan.id == PLAN_ID).with_for_update(skip_locked=True)
    )
    if not plan or not plan.enabled or not plan.next_run_at or plan.next_run_at > at:
        return
    # Only today's scheduled morning can be caught up, and only before 10:00 Shanghai.
    today = datetime.fromtimestamp(at / 1000, ZONE).replace(
        hour=8, minute=0, second=0, microsecond=0
    )
    today_ms = int(today.timestamp() * 1000)
    scheduled = max(plan.next_run_at, today_ms) if today_ms <= at else plan.next_run_at
    ident = str(uuid.uuid5(uuid.NAMESPACE_URL, f"briefing:{plan.id}:{scheduled}"))
    row = db.get(BriefingReport, ident)
    if not row:
        skipped = at >= scheduled + 2 * 3600000
        row = BriefingReport(
            id=ident,
            plan_id=plan.id,
            mode="scheduled",
            scheduled_for=scheduled,
            cutoff_at=scheduled,
            snapshot=freeze(db, plan),
            created_at=at,
            status="skipped" if skipped else "pending",
            body={},
            error="已超过当天 10:00 补发窗口" if skipped else None,
            finished_at=at if skipped else None,
        )
        db.add(row)
    plan.next_run_at = next_run(at)
    return row


def report_view(db, row):
    note = db.get(Notification, row.notification_id) if row.notification_id else None
    outbox = db.scalar(select(Outbox).where(Outbox.notification_id == note.id)) if note else None
    return {
        "id": row.id,
        "mode": row.mode,
        "status": row.status,
        "scheduled_for": row.scheduled_for,
        "cutoff_at": row.cutoff_at,
        "created_at": row.created_at,
        "started_at": row.started_at,
        "finished_at": row.finished_at,
        "snapshot": row.snapshot,
        "body": row.body,
        "error": row.error,
        "delivery": {
            "status": note.status,
            "outbox_status": outbox.status,
            "attempts": outbox.attempts,
            "reason": outbox.error,
        }
        if outbox
        else None,
    }


def reports(db, *, before=None, limit=20):
    if not 1 <= limit <= 20:
        raise ValueError("每页最多 20 条")
    query = select(BriefingReport).where(BriefingReport.mode == "scheduled")
    if before:
        try:
            stamp, ident = before.split(":", 1)
            query = query.where(
                or_(
                    BriefingReport.created_at < int(stamp),
                    and_(BriefingReport.created_at == int(stamp), BriefingReport.id < ident),
                )
            )
        except (ValueError, TypeError) as exc:
            raise ValueError("分页位置无效") from exc
    rows = list(
        db.scalars(
            query.order_by(BriefingReport.created_at.desc(), BriefingReport.id.desc()).limit(
                limit + 1
            )
        )
    )
    items = rows[:limit]
    return {
        "items": [report_view(db, row) for row in items],
        "next_cursor": f"{items[-1].created_at}:{items[-1].id}" if len(rows) > limit else None,
    }
