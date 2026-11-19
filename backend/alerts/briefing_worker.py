"""Single-owner morning generation, bounded reads and attempt-fenced publication."""

import copy
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy import or_, select

from . import briefing_inputs, briefing_sections
from . import briefing_service as service
from .storage import BriefingPlan, BriefingReport, Notification, Outbox, now_ms, transaction

BUDGET_MS = 180000


def display_percent(value):
    rounded = Decimal(value).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return "0.00%" if rounded == 0 else f"{rounded:+.2f}%"


def claim(*, at):
    with transaction() as db:
        service.due(db, at=at)
    with transaction() as db:
        row = db.scalar(
            select(BriefingReport)
            .where(
                or_(
                    BriefingReport.status == "pending",
                    (BriefingReport.status == "running")
                    & (BriefingReport.started_at < at - BUDGET_MS),
                )
            )
            .order_by(BriefingReport.created_at)
            .limit(1)
            .with_for_update(skip_locked=True)
        )
        if not row:
            return
        row.attempt += 1
        row.status, row.started_at = "running", at
        return {
            "id": row.id,
            "attempt": row.attempt,
            "snapshot": copy.deepcopy(row.snapshot),
            "cutoff": row.cutoff_at,
            "created_at": row.created_at,
        }


def generate(task, *, reader=briefing_inputs.read, progress=lambda: None):
    deadline = time.monotonic() + max(0, (task["created_at"] + BUDGET_MS - now_ms()) / 1000)
    if task["attempt"] > 2:
        deadline = time.monotonic()
    members = task["snapshot"]["members"]
    values = {}

    def collect(ticker, refresh):
        try:
            return reader(ticker, task["cutoff"], deadline=deadline, refresh=refresh)
        except Exception as exc:
            return {
                "ticker": ticker,
                "status": "source_error",
                "reason": type(exc).__name__ + ": 行情读取失败",
                "rows": [],
            }

    # First inspect every local snapshot. Then the shared history lane refills
    # provider tails with at most two concurrent network requests.
    for ticker in members:
        if time.monotonic() >= deadline:
            break
        values[ticker] = collect(ticker, False)
        progress()
    pending = [
        ticker
        for ticker in members
        if ticker.startswith("MWP:")
        and values.get(ticker, {}).get("status") not in ("ok", "unsupported")
    ]
    pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="briefing-input")
    try:
        flights = {}
        while (pending or flights) and time.monotonic() < deadline:
            while pending and len(flights) < 2:
                ticker = pending.pop(0)
                flights[pool.submit(collect, ticker, True)] = ticker
            done, _ = wait(
                flights,
                timeout=min(1, max(0, deadline - time.monotonic())),
                return_when=FIRST_COMPLETED,
            )
            for future in done:
                ticker = flights.pop(future)
                value = future.result()
                # A failed refresh may retain a dated old reference, but does
                # not qualify that reference as current ranking data.
                if value["status"] == "source_error" and values.get(ticker, {}).get("rows"):
                    values[ticker] = {
                        **values[ticker],
                        "status": "not_updated",
                        "reason": "本期刷新失败，保留已读历史参考",
                    }
                else:
                    values[ticker] = value
                progress()
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
    inputs = [
        values.get(ticker)
        or {"ticker": ticker, "status": "source_error", "reason": "本期读取预算已用完", "rows": []}
        for ticker in members
    ]
    sections = briefing_sections.compute(task["snapshot"]["sections"], inputs)
    good = sum(section.get("coverage", {}).get("ok", 0) for section in sections)
    issues = []
    if task["snapshot"]["missing_groups"]:
        issues.append("部分自选分组已删除，请更新计划")
    if not task["snapshot"]["groups"]:
        issues.append("配置失效：所选分组均已删除")
    if not members and task["snapshot"]["groups"]:
        issues.append("本期无扫描品种")
    errors = sum(
        item["status"] != "ok" for section in sections for item in section.get("items", [])
    )
    status = (
        "failed"
        if not good and (members or not task["snapshot"]["groups"])
        else "partial"
        if errors or issues or any(s.get("error") for s in sections)
        else "ready"
    )
    body = {
        "schema_version": 1,
        "sections": sections,
        "issues": issues,
        "coverage": {"ok": good, "total": len(members)},
    }
    return status, body


def publish(task, status, body, *, at=None):
    at = now_ms() if at is None else at
    with transaction() as db:
        row = db.scalar(
            select(BriefingReport).where(BriefingReport.id == task["id"]).with_for_update()
        )
        if not row or row.status != "running" or row.attempt != task["attempt"]:
            return False
        row.status, row.body, row.finished_at = status, body, at
        plan = db.get(BriefingPlan, row.plan_id)
        if row.mode == "scheduled":
            from .notification_transport import transport_config

            transport = transport_config(db)
            date = datetime.fromtimestamp(row.cutoff_at / 1000, service.ZONE).date().isoformat()
            coverage = body["coverage"]
            title = "每日晨报 · " + date
            message = (
                "本期无扫描品种"
                if coverage["total"] == 0 and status != "failed"
                else "简报未完成，请打开查看原因"
                if status == "failed"
                else f"最近交易日涨跌 · 有效 {coverage['ok']}/{coverage['total']} 个品种"
            )
            representatives = sorted(
                [
                    item
                    for section in body["sections"]
                    for item in section.get("items", [])
                    if item["status"] == "ok" and item.get("change_pct") is not None
                ],
                key=lambda x: float(x["change_pct"]),
                reverse=True,
            )
            for item in representatives[:3]:
                message += (
                    f"\n{item.get('symbol', item['ticker'])} {display_percent(item['change_pct'])}"
                )
            expires = row.scheduled_for + 2 * 3600000
            allowed = (
                plan.enabled and transport["enabled"] and bool(transport["topic"]) and at < expires
            )
            note = Notification(
                kind="briefing",
                status="pending" if allowed else "recorded",
                created_at=at,
                payload={
                    "report_id": row.id,
                    "expires_at": expires,
                    "title": title,
                    "message": message,
                },
            )
            db.add(note)
            db.flush()
            row.notification_id = note.id
            db.add(
                Outbox(
                    notification_id=note.id,
                    status="pending" if allowed else "cancelled",
                    attempts=0,
                    next_at=at,
                    error=None if allowed else "计划暂停、通知未启用或已超过投递时限",
                )
            )
        return True


def once(*, at=None, reader=briefing_inputs.read, progress=lambda: None):
    task = claim(at=now_ms() if at is None else at)
    if not task:
        return False
    status, body = generate(task, reader=reader, progress=progress)
    publish(task, status, body)
    return True


def run(stop):
    from .runtime_health import progress

    while not stop.is_set():
        error = None
        try:
            worked = once(progress=progress)
        except Exception as exc:
            error, worked = exc, False
        progress(error=error)
        if not worked:
            stop.wait(15)
