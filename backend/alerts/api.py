import asyncio
import hashlib
import json
import secrets
from collections import deque
from contextlib import asynccontextmanager
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx
from argon2 import PasswordHasher
from argon2.exceptions import VerificationError
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import delete, func, select

from . import business
from .business import WatchInput
from .calendar_profile import closures_from
from .chart_alert_message import signal_message
from .chart_series import is_gold
from .config import settings
from .domain import TIMEFRAMES, calendar_for, previous_session
from .notify import DEFAULTS
from .replay_history import history_rows, pack_history
from .service import acknowledge, add_replay_watch, replay_step
from .storage import (
    AckGrant,
    Audit,
    Bar,
    Device,
    DeviceReceipt,
    ImportJob,
    Instrument,
    LoginSession,
    Notification,
    Outbox,
    Preference,
    Replay,
    SignalRow,
    WeeklyHistoryRequest,
    bootstrap,
    candle_dict,
    instant,
    now_ms,
    transaction,
)


@asynccontextmanager
async def lifespan(app):
    from .swing_sr import register_indicator
    register_indicator()
    bootstrap()
    from .provider_chart import warm_clients
    await asyncio.to_thread(warm_clients)
    from .provider_service import start, stop
    start()
    from .provider_cache import interactive_busy
    from .provider_transport import start as start_transport
    start_transport(interactive_busy)
    app.router.routes[:] = [r for r in app.router.routes if getattr(r, "name", "") != "native_mcp"]
    try:
        if settings.mcp_enabled:
            from .mcp.server import create_server
            server, endpoint, adapter = create_server()
            # Restartable TestClient lifespans install exactly one route pair.
            app.add_route("/mcp", endpoint, methods=["GET", "POST", "DELETE", "OPTIONS"], name="native_mcp")
            app.add_route("/mcp/", endpoint, methods=["GET", "POST", "DELETE", "OPTIONS"], name="native_mcp")
            try:
                async with server.session_manager.run():
                    yield
            finally:
                await adapter.close()
                app.router.routes[:] = [r for r in app.router.routes if getattr(r, "name", "") != "native_mcp"]
        else:
            yield
    finally:
        await asyncio.to_thread(stop)
        from .provider_chart import close_clients
        close_clients()


app = FastAPI(title="守望 · Market Watch", lifespan=lifespan)


def digest(token):
    return hashlib.sha256(token.encode()).hexdigest()


def authenticated(request: Request):
    token = request.cookies.get("session", "")
    with transaction() as db:
        session = db.get(LoginSession, digest(token)) if token else None
        if not session or session.expires <= now_ms():
            raise HTTPException(401, "请先登录")
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            if not secrets.compare_digest(request.headers.get("x-csrf-token", ""), session.csrf):
                raise HTTPException(403, "请求校验失败，请刷新后重试")
        return session.csrf


class Credentials(BaseModel):
    password: str = Field(min_length=1, max_length=512)


@app.post("/api/login")
def login(body: Credentials, response: Response, request: Request):
    # Persisted rolling throttle works across processes/restarts.
    with transaction() as db:
        count = db.scalar(
            select(func.count())
            .select_from(Audit)
            .where(Audit.kind == "login_failed", Audit.at > now_ms() - 60_000)
        )
    if count >= 10:
        raise HTTPException(429, "尝试过于频繁，请一分钟后重试")
    token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(24)
    with transaction() as db:
        credential = db.scalar(select(Preference).where(Preference.key == "auth.admin").with_for_update())
        password_hash = credential.value.get("hash", settings.admin_password_hash)
        if not password_hash:
            raise HTTPException(503, "尚未设置管理员密码，请运行初始化命令")
        try:
            PasswordHasher().verify(password_hash, body.password)
        except VerificationError:
            valid = False
        else:
            valid = True
        if valid:
            db.add(LoginSession(token_hash=digest(token), csrf=csrf,
                                expires=now_ms() + settings.session_hours * 3600_000))
        else:
            db.add(Audit(kind="login_failed", details={}))
    if not valid:
        raise HTTPException(401, "密码不正确")
    response.set_cookie(
        "session",
        token,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="strict",
        max_age=settings.session_hours * 3600,
    )
    return {"csrf": csrf}


@app.get("/api/session")
def session(csrf=Depends(authenticated)):
    return {"csrf": csrf}


@app.post("/api/logout", dependencies=[Depends(authenticated)])
def logout(request: Request, response: Response):
    with transaction() as db:
        row = db.get(LoginSession, digest(request.cookies["session"]))
        if row:
            db.delete(row)
    response.delete_cookie("session")
    return {"ok": True}


class PasswordChange(BaseModel):
    current_password: str = Field(min_length=1, max_length=512)
    new_password: str = Field(min_length=6, max_length=512)


@app.post("/api/account/password", dependencies=[Depends(authenticated)])
def change_password(body: PasswordChange, request: Request):
    current_token = digest(request.cookies["session"])
    with transaction() as db:
        credential = db.scalar(select(Preference).where(Preference.key == "auth.admin").with_for_update())
        attempts = db.scalar(select(func.count()).select_from(Audit).where(
            Audit.kind == "password_change_failed", Audit.at > now_ms() - 60_000))
        if attempts >= 10:
            raise HTTPException(429, "尝试过于频繁，请一分钟后重试")
        try:
            PasswordHasher().verify(credential.value.get("hash", settings.admin_password_hash),
                                    body.current_password)
        except VerificationError:
            valid = False
            db.add(Audit(kind="password_change_failed", details={}))
        else:
            valid = True
            if body.current_password == body.new_password:
                raise HTTPException(422, "新密码不能与当前密码相同")
            credential.value = {"hash": PasswordHasher().hash(body.new_password)}
            db.execute(delete(LoginSession).where(LoginSession.token_hash != current_token))
            db.add(Audit(kind="password_changed", details={}))
    if not valid:
        raise HTTPException(400, "当前密码不正确")
    return {"ok": True}






@app.get("/api/instruments", dependencies=[Depends(authenticated)])
def instruments():
    return business.instruments()


@app.get("/api/candles", dependencies=[Depends(authenticated)])
def candles(instrument: str, timeframe: str = "H4", before: int | None = None, limit: int = 300):
    return business.candles(instrument, timeframe, before, limit)


@app.get("/api/watches", dependencies=[Depends(authenticated)])
def watches():
    return business.watches()


@app.get("/api/session-range", dependencies=[Depends(authenticated)])
def session_range(instrument: str, at: int | None = None):
    with transaction() as db:
        inst = db.get(Instrument, instrument)
        if not inst:
            raise HTTPException(404, "品种不存在")
        left, right = previous_session(
            instant(at or now_ms()),
            calendar_for(inst),
            gold=is_gold(inst.id),
            closures=closures_from(inst.calendar_profile),
        )
        row = db.scalar(
            select(Bar).where(
                Bar.instrument_id == instrument,
                Bar.timeframe == "D1",
                Bar.start == int(left.timestamp() * 1000),
                Bar.end == int(right.timestamp() * 1000),
            )
        )
        return {
            "start": int(left.timestamp() * 1000),
            "end": int(right.timestamp() * 1000),
            "complete": bool(row and row.complete),
            "high": str(row.high) if row and row.complete else None,
            "low": str(row.low) if row and row.complete else None,
        }


@app.post("/api/watches", dependencies=[Depends(authenticated)], status_code=201)
def new_watch(body: WatchInput):
    return business.new_watch(body)


@app.post("/api/watches/{watch_id}/cancel", dependencies=[Depends(authenticated)])
def cancel_watch(watch_id: str):
    return business.cancel_watch(watch_id)


@app.get("/api/signals", dependencies=[Depends(authenticated)])
def signals():
    return business.signals()


@app.post("/api/notifications/{notification_id}/retry", dependencies=[Depends(authenticated)])
def retry_notification(notification_id: str):
    with transaction() as db:
        note = db.scalar(
            select(Notification).where(Notification.id == notification_id).with_for_update()
        )
        if not note:
            raise HTTPException(404, "通知不存在")
        task = db.scalar(
            select(Outbox).where(Outbox.notification_id == notification_id).with_for_update()
        )
        if note.ack_at is not None or not task or task.status != "blocked":
            raise HTTPException(409, "只有未确认且因凭据错误暂停的通知可以手动重试")
        task.status = "pending"
        task.error = None
        task.next_at = now_ms()
        note.status = "pending"
        db.add(Audit(kind="notification_retried", details={"notification_id": notification_id}))
        return {"status": "pending"}


@app.post("/api/notifications/{notification_id}/ack", dependencies=[Depends(authenticated)])
def ack(notification_id: str):
    return business.ack(notification_id)


@app.post("/api/notification-actions/{notification_id}/ack")
def mobile_ack(notification_id: str, request: Request):
    token = request.headers.get("authorization", "").removeprefix("Bearer ")
    with transaction() as db:
        n = db.get(Notification, notification_id)
        grant = db.get(AckGrant, digest(token)) if token else None
        if not n or not grant or grant.notification_id != n.id:
            raise HTTPException(403, "确认凭证无效")
        n = acknowledge(db, n.id)
        return {"status": n.status}


@app.post("/api/notification-tests", dependencies=[Depends(authenticated)])
def send_notification_test():
    if not settings.ntfy_topic:
        raise HTTPException(409, "尚未配置 ntfy topic")
    with transaction() as db:
        # Serialize test requests with the existing notification preferences row.
        inst = db.scalar(select(Instrument).where(Instrument.id == "EURUSD").with_for_update())
        if not inst:
            raise HTTPException(503, "系统尚未初始化")
        last = db.scalar(
            select(func.max(Audit.at)).where(Audit.kind == "notification_test_requested")
        )
        if last is not None and now_ms() - last < 60000:
            raise HTTPException(429, "请间隔一分钟再发送测试")
        test_id = secrets.token_hex(16)
        token = secrets.token_urlsafe(32)
        db.add(
            Preference(
                key="test_ack:" + test_id,
                value={"token_hash": digest(token), "expires": now_ms() + 86400000, "ack_at": None},
            )
        )
        db.add(Audit(kind="notification_test_requested", details={"test_id": test_id}))
    headers = {"Authorization": f"Bearer {settings.ntfy_token}"} if settings.ntfy_token else {}
    body = {
        "topic": settings.ntfy_topic,
        "title": "守望 · 手机通知测试",
        "message": "这是你在工作台主动发送的测试通知，不是交易信号。点击打开工作台。",
        "priority": 5,
        "click": settings.public_url + "/settings",
        "actions": [
            {
                "action": "http",
                "label": "确认测试",
                "method": "POST",
                "url": f"{settings.public_url}/api/notification-tests/{test_id}/ack",
                "headers": {"Authorization": f"Bearer {token}"},
                "clear": True,
            }
        ],
    }
    try:
        with httpx.Client(timeout=15) as client:
            response = client.post(settings.ntfy_url.rstrip("/"), json=body, headers=headers)
            response.raise_for_status()
    except httpx.HTTPError:
        with transaction() as db:
            db.add(Audit(kind="notification_test_failed_or_unknown", details={"test_id": test_id}))
        raise HTTPException(502, "推送请求失败或结果未知，请先检查手机，避免重复发送")
    with transaction() as db:
        db.add(Audit(kind="notification_test_accepted", details={"test_id": test_id}))
    return {"status": "server_accepted", "device_delivery": "unknown"}


@app.post("/api/notification-tests/{test_id}/ack")
def acknowledge_test(test_id: str, request: Request):
    token = request.headers.get("authorization", "").removeprefix("Bearer ")
    with transaction() as db:
        row = db.scalar(
            select(Preference).where(Preference.key == "test_ack:" + test_id).with_for_update()
        )
        if (
            not token
            or not row
            or not secrets.compare_digest(row.value["token_hash"], digest(token))
        ):
            raise HTTPException(403, "测试确认凭证无效")
        if row.value["expires"] < now_ms():
            raise HTTPException(403, "测试确认凭证已过期")
        if row.value["ack_at"] is None:
            row.value = {**row.value, "ack_at": now_ms()}
            db.add(Audit(kind="notification_test_acknowledged", details={"test_id": test_id}))
        return {"status": "acknowledged"}


@app.get("/healthz")
def healthz():
    return {"status": "ok", "time": now_ms()}


@app.get("/readyz")
def readyz(response: Response):
    try:
        with transaction() as db:
            db.execute(select(func.count()).select_from(Instrument)).scalar_one()
        return {"status": "ready", "time": now_ms()}
    except Exception:
        response.status_code = 503
        return {"status": "not_ready", "time": now_ms()}


@app.get("/api/health", dependencies=[Depends(authenticated)])
def health():
    with transaction() as db:
        pending = db.scalar(
            select(func.count()).select_from(Outbox).where(Outbox.status == "pending")
        )
        latest = dict(
            db.execute(
                select(Audit.kind, func.max(Audit.at))
                .where(Audit.kind.in_(["market_heartbeat", "notify_heartbeat", "import_heartbeat"]))
                .group_by(Audit.kind)
            ).all()
        )
        worker_status = {
            kind: "unknown"
            if kind not in latest
            else "running"
            if now_ms() - latest[kind] < 300_000
            else "stale"
            for kind in ["market_heartbeat", "notify_heartbeat", "import_heartbeat"]
        }
        blocked = db.scalar(
            select(func.count()).select_from(Outbox).where(Outbox.status == "blocked")
        )
        requested = db.scalar(
            select(Audit)
            .where(Audit.kind == "notification_test_requested")
            .order_by(Audit.id.desc())
            .limit(1)
        )
        last_test_result = None
        if requested:
            test_id = requested.details.get("test_id")
            grant = db.get(Preference, "test_ack:" + test_id) if test_id else None
            outcomes = db.scalars(
                select(Audit)
                .where(
                    Audit.id >= requested.id,
                    Audit.kind.in_(
                        [
                            "notification_test_requested",
                            "notification_test_accepted",
                            "notification_test_failed_or_unknown",
                        ]
                    ),
                )
                .order_by(Audit.id.desc())
            ).all()
            outcome = next((r for r in outcomes if r.details.get("test_id") == test_id), requested)
            last_test_result = {"status": outcome.kind, "at": outcome.at}
            if grant and grant.value.get("ack_at") is not None:
                last_test_result = {
                    "status": "notification_test_acknowledged",
                    "at": grant.value["ack_at"],
                }
        return {
            "time": now_ms(),
            "pending_notifications": pending,
            "backup": backup_health(db),
            "market_incidents": market_incidents(db),
            "last_notification_test": last_test_result,
            "workers": latest,
            "worker_status": worker_status,
            "blocked_notifications": blocked,
            "delivery_enabled": settings.delivery_enabled,
            "ntfy_configured": bool(settings.ntfy_topic),
            "mobile_condition": "开启即时投递；不要从最近任务划掉 ntfy。手机送达状态未知。",
        }


def market_incidents(db):
    result = []
    for instrument in db.scalars(select(Instrument).where(Instrument.enabled.is_(True))):
        predicate = Audit.details["instrument"].as_string() == instrument.id
        count = db.scalar(
            select(func.count())
            .select_from(Audit)
            .where(predicate, Audit.kind == "market_error", Audit.at >= now_ms() - 86400000)
        )
        last_error = db.scalar(
            select(func.max(Audit.at)).where(predicate, Audit.kind == "market_error")
        )
        last_recovery = db.scalar(
            select(func.max(Audit.at)).where(predicate, Audit.kind == "market_recovered")
        )
        result.append(
            {
                "instrument": instrument.id,
                "errors_24h": count,
                "last_error_at": last_error,
                "last_recovered_at": last_recovery,
                "current_error": bool(instrument.error),
            }
        )
    return result


def backup_health(db):
    latest = db.scalar(
        select(Audit)
        .where(Audit.kind.in_(["backup_completed", "backup_failed"]))
        .order_by(Audit.at.desc(), Audit.id.desc())
        .limit(1)
    )
    if not latest:
        return {"status": "unknown", "at": None}
    return {
        "status": "failed"
        if latest.kind == "backup_failed"
        else "stale"
        if now_ms() - latest.at > 36 * 3600000
        else "recent",
        "at": latest.at,
        "bytes": latest.details.get("bytes"),
    }


@app.get("/api/events", dependencies=[Depends(authenticated)])
async def events(request: Request, after: int = 0):
    async def stream():
        cursor = max(after, int(request.headers.get("last-event-id", "0") or 0))
        while not await request.is_disconnected():
            with transaction() as db:
                rows = db.scalars(
                    select(Audit).where(Audit.id > cursor).order_by(Audit.id).limit(100)
                ).all()
            for row in rows:
                cursor = row.id
                yield f"id: {row.id}\ndata: {json.dumps({'kind': row.kind, 'at': row.at})}\n\n"
            yield ": heartbeat\n\n"
            await asyncio.sleep(3)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


class NotificationSettings(BaseModel):
    quiet_enabled: bool = False
    quiet_start: str = Field(default="23:00", pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$")
    quiet_end: str = Field(default="07:00", pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$")
    timezone: str = "Asia/Shanghai"
    priority: int = Field(default=5, ge=1, le=5)
    repeat_seconds: int = Field(default=30, ge=5, le=3600)
    ring_seconds: int = Field(default=15, ge=1, le=120)
    max_repeats: int = Field(default=0, ge=0, le=1000)
    mode: Literal["ntfy_native", "companion"] = "ntfy_native"

    @model_validator(mode="after")
    def valid(self):
        try:
            ZoneInfo(self.timezone)
        except ZoneInfoNotFoundError:
            raise ValueError("未知时区")
        if self.quiet_enabled and self.quiet_start == self.quiet_end:
            raise ValueError("静音开始与结束时间不能相同")
        return self


@app.get("/api/settings/notifications", dependencies=[Depends(authenticated)])
def notification_settings():
    with transaction() as db:
        row = db.get(Preference, "notifications")
        return {
            **DEFAULTS,
            **(row.value if row else {}),
            "capabilities": {
                "server_quiet_hours": True,
                "native_exact_cadence": False,
                "remote_stop_verified": False,
            },
        }


@app.post("/api/settings/notifications", dependencies=[Depends(authenticated)])
def save_notification_settings(body: NotificationSettings):
    with transaction() as db:
        if body.mode == "companion" and not db.scalar(
            select(Device).where(Device.revoked.is_(False))
        ):
            raise HTTPException(422, "请先配对提醒客户端")
        row = db.get(Preference, "notifications")
        if row:
            row.value = body.model_dump()
        else:
            db.add(Preference(key="notifications", value=body.model_dump()))
        db.add(Audit(kind="notification_settings", details=body.model_dump()))
    return body.model_dump()


def device_auth(request: Request):
    token = request.headers.get("authorization", "").removeprefix("Bearer ")
    with transaction() as db:
        device = (
            db.scalar(
                select(Device).where(Device.token_hash == digest(token), Device.revoked.is_(False))
            )
            if token
            else None
        )
        if not device:
            raise HTTPException(401, "设备凭证无效")
        device.last_seen = now_ms()
        return device.id


class DeviceInput(BaseModel):
    name: str = Field(min_length=1, max_length=80)


@app.post("/api/devices", dependencies=[Depends(authenticated)], status_code=201)
def pair_device(body: DeviceInput):
    token = secrets.token_urlsafe(32)
    with transaction() as db:
        device = Device(name=body.name, token_hash=digest(token))
        db.add(device)
        db.flush()
        return {"id": device.id, "token": token, "server_url": settings.public_url}


@app.get("/api/devices", dependencies=[Depends(authenticated)])
def devices():
    with transaction() as db:
        return [
            {k: getattr(d, k) for k in ["id", "name", "last_seen", "revoked"]}
            for d in db.scalars(select(Device))
        ]


@app.post("/api/devices/{device_id}/revoke", dependencies=[Depends(authenticated)])
def revoke_device(device_id: str):
    with transaction() as db:
        device = db.get(Device, device_id)
        if not device:
            raise HTTPException(404, "设备不存在")
        device.revoked = True
        return {"revoked": True}


@app.get("/api/device/sync")
def sync_device(device_id=Depends(device_auth)):
    with transaction() as db:
        pref = db.get(Preference, "notifications")
        config = {**DEFAULTS, **(pref.value if pref else {})}
        pending = db.execute(
            select(Notification, SignalRow)
            .join(SignalRow, SignalRow.id == Notification.signal_id)
            .where(Notification.ack_at.is_(None))
            .order_by(Notification.created_at)
        ).all()
        acked = db.scalars(
            select(Notification.id)
            .where(Notification.ack_at.is_not(None))
            .order_by(Notification.ack_at.desc())
            .limit(1000)
        ).all()
        return {
            "server_time": now_ms(),
            "config": config,
            "acked": acked,
            "pending_snapshot_complete": True,
            "events": [
                {
                    "id": n.id,
                    "signal_id": s.id,
                    "title": f"{s.instrument_id} · {s.reason}",
                    "message": signal_message(s) if s.evidence.get("chart_alert") else f"价格 {s.price} / 阈值 {s.threshold}",
                    "occurred_at": s.occurred_at,
                }
                for n, s in pending
                if not s.evidence.get("chart_alert") or (
                    s.evidence["config"].get("notify_ntfy") and n.status != "late_suppressed"
                )
            ],
        }


@app.post("/api/device/notifications/{notification_id}/received")
def device_received(notification_id: str, device_id=Depends(device_auth)):
    with transaction() as db:
        if not db.get(Notification, notification_id):
            raise HTTPException(404, "通知不存在")
        existing = db.scalar(
            select(DeviceReceipt).where(
                DeviceReceipt.device_id == device_id,
                DeviceReceipt.notification_id == notification_id,
            )
        )
        if not existing:
            db.add(DeviceReceipt(device_id=device_id, notification_id=notification_id))
        return {"received": True}


@app.post("/api/device/notifications/{notification_id}/ack")
def device_ack(notification_id: str, device_id=Depends(device_auth)):
    with transaction() as db:
        try:
            n = acknowledge(db, notification_id)
            return {"id": n.id, "status": n.status}
        except ValueError:
            raise HTTPException(404, "通知不存在")


class ReplayInput(BaseModel):
    instrument_id: str = Field(min_length=1, max_length=40, pattern=r"^[A-Za-z0-9:_-]+$")
    dataset_version: str | None = Field(default=None, max_length=36)
    timeframe: str = "H4"
    start: int
    end: int


@app.post("/api/imports", dependencies=[Depends(authenticated)], status_code=201)
def create_import(body: ReplayInput):
    if (
        body.start < 0
        or body.end <= body.start
        or body.end > now_ms()
        or body.end - body.start > 366 * 86400_000
    ):
        raise HTTPException(422, "历史范围须在过去且不超过一年")
    with transaction() as db:
        from .storage import MarketDataset

        if not db.get(Instrument, body.instrument_id):
            raise HTTPException(404, "未知品种")
        if db.scalar(select(MarketDataset.id).where(MarketDataset.instrument_id == body.instrument_id)):
            raise HTTPException(422, "显式历史数据集使用版本化导入入口")
        job = ImportJob(
            instrument_id=body.instrument_id, start=body.start, end=body.end, cursor=body.start
        )
        db.add(job)
        db.flush()
        return {"id": job.id, "status": job.status}


@app.post("/api/imports/{job_id}/retry", dependencies=[Depends(authenticated)])
def retry_import(job_id: str):
    with transaction() as db:
        job = db.scalar(select(ImportJob).where(ImportJob.id == job_id).with_for_update())
        if not job:
            raise HTTPException(404, "补数任务不存在")
        if job.status != "failed":
            raise HTTPException(409, "只有失败的任务可以手动重试")
        job.status = "pending"
        job.attempts = 0
        job.error = None
        job.lease_until = None
        job.next_at = now_ms()
        db.add(Audit(kind="import_retried", details={"job_id": job.id, "cursor": job.cursor}))
        return {"id": job.id, "status": job.status, "cursor": job.cursor}


@app.get("/api/imports", dependencies=[Depends(authenticated)])
def imports():
    with transaction() as db:
        return [
            {
                k: getattr(j, k)
                for k in [
                    "id",
                    "instrument_id",
                    "start",
                    "end",
                    "cursor",
                    "status",
                    "error",
                    "priority",
                ]
            }
            for j in db.scalars(
                select(ImportJob)
                .order_by(
                    (ImportJob.status == "failed").desc(),
                    (ImportJob.status != "complete").desc(),
                    ImportJob.priority,
                    ImportJob.start.desc(),
                    ImportJob.created_at.desc(),
                )
                .limit(30)
            )
        ]


@app.get("/api/imports-summary", dependencies=[Depends(authenticated)])
def imports_summary():
    with transaction() as db:
        counts = dict(
            db.execute(select(ImportJob.status, func.count()).group_by(ImportJob.status)).all()
        )
        weekly = db.scalars(select(WeeklyHistoryRequest).order_by(
            (WeeklyHistoryRequest.status == "needs_review").desc(),
            (WeeklyHistoryRequest.status != "complete").desc(),
            WeeklyHistoryRequest.before.desc(),
        ).limit(30)).all()
        return {"total": sum(counts.values()), "counts": counts, "shown_limit": 30,
                "weekly_requests": [{key: getattr(row, key) for key in
                    ("id", "instrument_id", "before", "cursor", "remaining", "status")}
                    for row in weekly]}


def replay_dict(run, *, full_history=False):
    visible = [b for b in run.bars if b["end"] <= run.cursor]
    return {
        **{
            k: getattr(run, k)
            for k in [
                "id",
                "instrument_id",
                "timeframe",
                "start",
                "end",
                "cursor",
                "watches",
                "signals",
            ]
        },
        "bars": list(history_rows(run)) if full_history else visible[-2000:],
        "chart_bar_limit": 2000,
        "warmup_bar_count": run.warmup_count or 0,
        "chart_history_limited": (run.warmup_count or 0) > 500 or len(visible) > 2000,
        "calendar_profile": run.calendar_profile or {},
        "dataset_version": run.dataset_version,
        "input_manifest": run.input_manifest or {},
        "finished": not any(run.cursor < b["end"] <= run.end for b in run.bars),
    }


@app.get("/api/replays", dependencies=[Depends(authenticated)])
def list_replays():
    with transaction() as db:
        runs = db.scalars(select(Replay).order_by(Replay.created_at.desc()).limit(100)).all()
        return [
            {
                k: getattr(run, k)
                for k in [
                    "id",
                    "instrument_id",
                    "timeframe",
                    "start",
                    "end",
                    "cursor",
                    "created_at",
                ]
            }
            for run in runs
        ]


@app.get("/api/replays/{run_id}/export", dependencies=[Depends(authenticated)])
def export_replay(run_id: str):
    with transaction() as db:
        run = db.get(Replay, run_id)
        if not run:
            raise HTTPException(404, "演练不存在")
        data = replay_dict(run, full_history=True)
        data["export_version"] = 1
        data["simulated"] = True
        return Response(
            json.dumps(data, ensure_ascii=False),
            media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="replay-{run.id}.json"'},
        )


@app.post("/api/replays", dependencies=[Depends(authenticated)], status_code=201)
def new_replay(body: ReplayInput):
    from .chart_data import FRAMES

    if body.timeframe not in (FRAMES if body.dataset_version else TIMEFRAMES) or body.end <= body.start:
        raise HTTPException(422, "请选择有效的周期与日期范围")
    with transaction() as db:
        from .history_replay import create_replay
        from .storage import MarketDataset

        instrument = db.get(Instrument, body.instrument_id)
        if not instrument:
            raise HTTPException(404, "未知品种")
        explicit = db.scalar(select(MarketDataset.id).where(
            MarketDataset.instrument_id == body.instrument_id))
        if explicit or body.dataset_version:
            if not body.dataset_version:
                raise HTTPException(422, "显式数据集回测必须指定不可变历史版本")
            try:
                run = create_replay(db, instrument, body.dataset_version, body.timeframe, body.start, body.end)
                return replay_dict(run)
            except ValueError as error:
                raise HTTPException(422, str(error)) from None
        # Warmup bars precede selected range, but future is never sent to the browser.
        bars = db.scalars(
            select(Bar)
            .where(
                Bar.instrument_id == body.instrument_id,
                Bar.timeframe == body.timeframe,
                Bar.end > body.start,
                Bar.end <= body.end,
            )
            .order_by(Bar.start.desc())
            .limit(20001)
        ).all()[::-1]
        if len(bars) > 20000:
            raise HTTPException(422, "回放超过 20000 根，请缩小日期范围")
        if not any(b.end > body.start for b in bars):
            raise HTTPException(422, "所选范围还没有历史数据，请先导入")
        warmup = db.scalars(
            select(Bar)
            .where(
                Bar.instrument_id == body.instrument_id,
                Bar.timeframe == body.timeframe,
                Bar.end <= body.start,
            )
            .order_by(Bar.start)
            .execution_options(yield_per=1000)
        )
        context = deque(maxlen=500)

        def warmup_rows():
            for row in warmup:
                snapshot = candle_dict(row.candle())
                context.append(snapshot)
                yield snapshot

        warmup_snapshot, warmup_count = pack_history(warmup_rows())
        days = db.scalars(
            select(Bar)
            .where(
                Bar.instrument_id == body.instrument_id, Bar.timeframe == "D1", Bar.end <= body.end
            )
            .order_by(Bar.start)
        ).all()
        run = Replay(
            instrument_id=body.instrument_id,
            calendar_profile=db.get(Instrument, body.instrument_id).calendar_profile,
            timeframe=body.timeframe,
            start=body.start,
            end=body.end,
            cursor=body.start,
            bars=[*context, *[candle_dict(b.candle()) for b in bars]],
            warmup_snapshot=warmup_snapshot,
            warmup_count=warmup_count,
            days=[candle_dict(b.candle()) for b in days],
            watches=[],
            signals=[],
        )
        db.add(run)
        db.flush()
        return replay_dict(run)


@app.get("/api/replays/{run_id}", dependencies=[Depends(authenticated)])
def get_replay(run_id: str):
    with transaction() as db:
        run = db.get(Replay, run_id)
        if not run:
            raise HTTPException(404, "演练不存在")
        return replay_dict(run)


class StepInput(BaseModel):
    count: int = Field(default=1, ge=1, le=1000)


@app.post("/api/replays/{run_id}/step", dependencies=[Depends(authenticated)])
def step(run_id: str, body: StepInput):
    with transaction() as db:
        run = db.scalar(select(Replay).where(Replay.id == run_id).with_for_update())
        if not run:
            raise HTTPException(404, "演练不存在")
        replay_step(run, db.get(Instrument, run.instrument_id).calendar, body.count)
        return replay_dict(run)


@app.post("/api/replays/{run_id}/watches", dependencies=[Depends(authenticated)])
def replay_watch(run_id: str, body: WatchInput):
    with transaction() as db:
        run = db.scalar(select(Replay).where(Replay.id == run_id).with_for_update())
        if not run:
            raise HTTPException(404, "演练不存在")
        if body.instrument_id != run.instrument_id:
            raise HTTPException(422, "品种与演练不一致")
        try:
            add_replay_watch(
                run,
                body.name,
                body.rule(),
                db.get(Instrument, run.instrument_id).calendar,
                use_history=body.use_history,
            )
        except ValueError as e:
            raise HTTPException(422, str(e))
        return replay_dict(run)


class SeekInput(BaseModel):
    cursor: int


@app.post("/api/replays/{run_id}/seek", dependencies=[Depends(authenticated)], status_code=201)
def seek(run_id: str, body: SeekInput):
    with transaction() as db:
        old = db.get(Replay, run_id)
        if not old:
            raise HTTPException(404, "演练不存在")
        if not old.start <= body.cursor <= old.end:
            raise HTTPException(422, "定位时间超出范围")
        run = Replay(
            instrument_id=old.instrument_id,
            dataset_version=old.dataset_version,
            input_manifest=old.input_manifest,
            calendar_profile=old.calendar_profile,
            timeframe=old.timeframe,
            start=old.start,
            end=old.end,
            cursor=body.cursor,
            bars=old.bars,
            warmup_snapshot=old.warmup_snapshot,
            warmup_count=old.warmup_count,
            days=old.days,
            watches=[],
            signals=[],
        )
        db.add(run)
        db.flush()
        return replay_dict(run)


# Standalone chart module: same authentication, no strategy API changes.
from .chart_api import router as chart_router  # noqa: E402

app.include_router(chart_router(authenticated))

from .market_stream_api import router as market_stream_router

app.include_router(market_stream_router(authenticated))

from .advanced_api import router as advanced_router  # noqa: E402

app.include_router(advanced_router(authenticated))

from .market_data import router as market_data_router  # noqa: E402

app.include_router(market_data_router(authenticated))

from .history_api import router as history_router  # noqa: E402

app.include_router(history_router(authenticated))

from .composite_api import router as composite_router  # noqa: E402

app.include_router(composite_router(authenticated))

from .live_api import router as live_router  # noqa: E402

app.include_router(live_router(authenticated))

from .chart_alert_api import router as chart_alert_router  # noqa: E402

app.include_router(chart_alert_router(authenticated))
