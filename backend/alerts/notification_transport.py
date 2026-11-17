"""Shared live ntfy settings; credentials stay on the server."""
from urllib.parse import urlsplit
import httpx
from fastapi import HTTPException
from pydantic import BaseModel, Field, SecretStr, model_validator
from sqlalchemy import select
from .config import settings
from .storage import Audit, Notification, Outbox, Preference, now_ms, transaction

KEY = "notification_transport"


def transport_config(db=None):
    if db is None:
        with transaction() as session:
            return transport_config(session)
    row = db.get(Preference, KEY)
    return {"url": settings.ntfy_url.rstrip("/"), "topic": settings.ntfy_topic,
            "token": settings.ntfy_token, "enabled": settings.delivery_enabled,
            "revision": 0, **(row.value if row else {})}


def public_config(config):
    return {k: v for k, v in config.items() if k != "token"} | {"token_configured": bool(config["token"])}


def phone_reason(db=None):
    config = transport_config(db)
    return "phone_topic_missing" if not config["topic"].strip() else (
        "phone_delivery_disabled" if not config["enabled"] else None)


class TransportInput(BaseModel):
    url: str = Field(min_length=1, max_length=2048)
    topic: str = Field(default="", max_length=64, pattern=r"^[A-Za-z0-9_-]*$")
    token: SecretStr | None = None
    clear_token: bool = False
    enabled: bool = False
    revision: int = Field(default=0, ge=0)

    @model_validator(mode="after")
    def valid(self):
        self.url = self.url.strip().rstrip("/")
        url = urlsplit(self.url)
        if url.port is not None and not 1 <= url.port <= 65535:
            raise ValueError("服务地址端口无效")
        if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password or url.query or url.fragment:
            raise ValueError("请输入 http 或 https 服务地址，不包含账号、参数或片段")
        if self.enabled and not self.topic:
            raise ValueError("请先填写订阅主题，再开启后台通知")
        if self.token and any(c in self.token.get_secret_value() for c in "\r\n"):
            raise ValueError("访问令牌不能包含换行")
        return self


def read_transport():
    with transaction() as db:
        latest = db.scalar(select(Audit).where(Audit.kind == "notification_test_requested")
                           .order_by(Audit.id.desc()).limit(1))
        config = transport_config(db)
        test_id = latest.details.get("test_id") if latest else None
        grant = db.get(Preference, "test_notification:" + test_id) if test_id else None
        note = db.get(Notification, grant.value["notification_id"]) if grant else None
        current_test = note and note.payload.get("transport_revision", 0) == config["revision"]
        return public_config(config) | {"last_test_id": test_id if current_test else None}


def save_transport(body: TransportInput):
    with transaction() as db:
        from .storage import Instrument
        db.scalar(select(Instrument).where(Instrument.id == "EURUSD").with_for_update())
        old = transport_config(db)
        if old["revision"] != body.revision:
            raise HTTPException(409, "通知配置已在其他页面更新，请重新读取后修改")
        config = {"url": body.url, "topic": body.topic, "enabled": body.enabled,
                  "revision": old["revision"] + 1,
                  "token": "" if body.clear_token else (
                      body.token.get_secret_value() if body.token and body.token.get_secret_value() else old["token"])}
        row = db.get(Preference, KEY)
        if row:
            row.value = config
        else:
            db.add(Preference(key=KEY, value=config))
        suppressed = 0
        if config["enabled"] and not old["enabled"]:
            # Keep disabled-period history without ringing for an old backlog.
            notes = db.scalars(select(Notification).where(Notification.kind != "test",
                Notification.ack_at.is_(None), Notification.status.in_(("pending", "delivery_error", "quiet")))
                .with_for_update()).all()
            for note in notes:
                task = db.scalar(select(Outbox).where(Outbox.notification_id == note.id).with_for_update())
                if task and task.status in ("pending", "blocked"):
                    note.status, task.status = "late_suppressed", "cancelled"
                    suppressed += 1
        for task in db.scalars(select(Outbox).where(Outbox.status == "blocked").with_for_update()):
            task.status, task.next_at, task.error = "pending", now_ms(), None
        db.add(Audit(kind="notification_transport_saved", details={
            "revision": config["revision"], "enabled": config["enabled"],
            "token_configured": bool(config["token"]), "suppressed_backlog": suppressed}))
        return public_config(config)


def check_connection(client=None):
    config = transport_config()
    headers = {"Authorization": f"Bearer {config['token']}"} if config["token"] else {}
    response = None
    try:
        if client is None:
            with httpx.Client(timeout=10, follow_redirects=False) as transport:
                response = transport.get(config["url"] + "/v1/health", headers=headers)
        else:
            response = client.get(config["url"] + "/v1/health", headers=headers)
        response.raise_for_status()
        if response.json().get("healthy") is not True:
            raise ValueError("Not an ntfy health response")
        result = {"ok": True, "message": "ntfy 服务可达；发布权限和手机接收请用测试通知确认。"}
    except (httpx.HTTPError, ValueError):
        status = response.status_code if response is not None else None
        result = {"ok": False, "message": "服务拒绝访问，请检查地址与访问令牌。" if status in (401, 403)
                  else "无法连接 ntfy 服务，请检查地址、网络或证书。"}
    result["at"] = now_ms()
    with transaction() as db:
        db.add(Audit(kind="notification_connection_checked", details=result))
    return result
