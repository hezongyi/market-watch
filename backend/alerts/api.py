import asyncio
import hashlib
import json
import secrets
from contextlib import asynccontextmanager
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx
from argon2 import PasswordHasher
from argon2.exceptions import VerificationError
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import func, select

from .calendar_profile import closures_from
from .config import settings
from .domain import TIMEFRAMES, Calendar, previous_session, scheduled_open
from .notify import DEFAULTS
from .service import acknowledge, add_replay_watch, create_watch, replay_step
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
    Quote,
    Replay,
    SignalRow,
    Watch,
    bootstrap,
    candle_dict,
    instant,
    now_ms,
    rule_from,
    transaction,
)


@asynccontextmanager
async def lifespan(app):
    bootstrap()
    yield


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
    if not settings.admin_password_hash:
        raise HTTPException(503, "尚未设置管理员密码，请运行初始化命令")
    try:
        PasswordHasher().verify(settings.admin_password_hash, body.password)
    except VerificationError:
        with transaction() as db:
            db.add(Audit(kind="login_failed", details={}))
        raise HTTPException(401, "密码不正确")
    token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(24)
    with transaction() as db:
        db.add(
            LoginSession(
                token_hash=digest(token),
                csrf=csrf,
                expires=now_ms() + settings.session_hours * 3600_000,
            )
        )
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


def watch_dict(w):
    return {
        k: getattr(w, k)
        for k in (
            "id",
            "instrument_id",
            "name",
            "rule",
            "state",
            "status",
            "armed_at",
            "paused_reason",
            "warmup_start",
        )
    }


class WatchInput(BaseModel):
    instrument_id: Literal["EURUSD", "XAUUSD", "BTCUSD", "BTCUSDT"]
    name: str = Field(min_length=1, max_length=100)
    kind: Literal["pullback", "previous_day", "price", "indicator"]
    timeframe: str = "H4"
    direction: Literal["buy", "sell", "both"] = "both"
    consecutive: int = Field(default=2, ge=2, le=100)
    level: str | None = None
    touch: bool = False
    use_history: bool = True
    indicator: str = "sma_cross"
    indicator_version: str = "1"
    indicator_params: dict = Field(default_factory=dict)

    def rule(self):
        return {
            k: getattr(self, k)
            for k in [
                "kind",
                "timeframe",
                "direction",
                "consecutive",
                "level",
                "touch",
                "indicator",
                "indicator_version",
                "indicator_params",
            ]
        }

    @model_validator(mode="after")
    def check_rule(self):
        rule_from(self.rule())
        return self


@app.get("/api/instruments", dependencies=[Depends(authenticated)])
def instruments():
    with transaction() as db:
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
                            Calendar(inst.calendar),
                            gold=inst.id == "XAUUSD",
                            closures=closures_from(inst.calendar_profile),
                        )
                        else "stale"
                        if now_ms() - latest.end > 180_000
                        else "receiving"
                    ),
                    "age_seconds": (now_ms() - latest.end) // 1000 if latest else None,
                }
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
        return result


@app.get("/api/candles", dependencies=[Depends(authenticated)])
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


@app.get("/api/watches", dependencies=[Depends(authenticated)])
def watches():
    with transaction() as db:
        return [watch_dict(w) for w in db.scalars(select(Watch).order_by(Watch.created_at.desc()))]


@app.get("/api/session-range", dependencies=[Depends(authenticated)])
def session_range(instrument: str, at: int | None = None):
    with transaction() as db:
        inst = db.get(Instrument, instrument)
        if not inst:
            raise HTTPException(404, "品种不存在")
        left, right = previous_session(
            instant(at or now_ms()),
            Calendar(inst.calendar),
            gold=inst.id == "XAUUSD",
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
    with transaction() as db:
        try:
            return watch_dict(
                create_watch(
                    db, body.instrument_id, body.name, body.rule(), use_history=body.use_history
                )
            )
        except ValueError as e:
            raise HTTPException(422, str(e))


@app.post("/api/watches/{watch_id}/cancel", dependencies=[Depends(authenticated)])
def cancel_watch(watch_id: str):
    with transaction() as db:
        w = db.scalar(select(Watch).where(Watch.id == watch_id).with_for_update())
        if not w:
            raise HTTPException(404, "监控不存在")
        if w.status == "active":
            w.status = "cancelled"
            db.add(Audit(kind="watch_cancelled", details={"watch_id": watch_id}))
        return watch_dict(w)


@app.get("/api/signals", dependencies=[Depends(authenticated)])
def signals():
    with transaction() as db:
        rows = db.execute(
            select(SignalRow, Notification)
            .join(Notification, Notification.signal_id == SignalRow.id)
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
                and n.ack_at is None,
            }
            for s, n in rows
        ]


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
    with transaction() as db:
        try:
            n = acknowledge(db, notification_id)
            return {"id": n.id, "status": n.status}
        except ValueError:
            raise HTTPException(404, "通知不存在")


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
            "last_notification_test": last_test_result,
            "workers": latest,
            "worker_status": worker_status,
            "blocked_notifications": blocked,
            "delivery_enabled": settings.delivery_enabled,
            "ntfy_configured": bool(settings.ntfy_topic),
            "mobile_condition": "开启即时投递；不要从最近任务划掉 ntfy。手机送达状态未知。",
        }


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
                    "message": f"价格 {s.price} / 阈值 {s.threshold}",
                    "occurred_at": s.occurred_at,
                }
                for n, s in pending
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
    instrument_id: Literal["EURUSD", "XAUUSD", "BTCUSD", "BTCUSDT"]
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
        return {"total": sum(counts.values()), "counts": counts, "shown_limit": 30}


def replay_dict(run):
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
        "bars": [b for b in run.bars if b["end"] <= run.cursor],
        "calendar_profile": run.calendar_profile or {},
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
        data = replay_dict(run)
        data["export_version"] = 1
        data["simulated"] = True
        return Response(
            json.dumps(data, ensure_ascii=False),
            media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="replay-{run.id}.json"'},
        )


@app.post("/api/replays", dependencies=[Depends(authenticated)], status_code=201)
def new_replay(body: ReplayInput):
    if body.timeframe not in TIMEFRAMES or body.end <= body.start:
        raise HTTPException(422, "请选择有效的周期与日期范围")
    with transaction() as db:
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
            .order_by(Bar.start.desc())
            .limit(20001)
        ).all()[::-1]
        if len(warmup) > 20000:
            raise HTTPException(422, "开启前历史超过当前演练容量，不能截断策略准备状态")
        bars = warmup + bars
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
            bars=[candle_dict(b.candle()) for b in bars],
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
            calendar_profile=old.calendar_profile,
            timeframe=old.timeframe,
            start=old.start,
            end=old.end,
            cursor=body.cursor,
            bars=old.bars,
            days=old.days,
            watches=[],
            signals=[],
        )
        db.add(run)
        db.flush()
        return replay_dict(run)
