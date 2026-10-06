"""Revocable per-agent opaque bearer credentials; database stores hashes only."""

import hashlib
import secrets
import time

from sqlalchemy import case, update
from starlette.responses import JSONResponse

from ..capabilities.context import CallContext, current_identity
from ..capabilities.registry import SCOPES
from ..config import settings
from ..storage import AgentCredential, Audit, now_ms, transaction, uid


def digest(token):
    return hashlib.sha256(token.encode()).hexdigest()


def issue(agent_id, scopes, expires_at):
    if (
        not agent_id
        or len(agent_id) > 80
        or not scopes
        or not set(scopes) <= SCOPES
        or expires_at <= now_ms()
    ):
        raise ValueError("Invalid agent, scopes or expiration")
    token = secrets.token_urlsafe(48)
    with transaction() as db:
        db.add(
            AgentCredential(
                token_hash=digest(token),
                agent_id=agent_id,
                scopes=sorted(set(scopes)),
                expires_at=expires_at,
            )
        )
        db.add(
            Audit(
                kind="agent_credential_issued",
                details={"agent_id": agent_id, "scopes": sorted(scopes)},
            )
        )
    return token


def revoke(token_hash):
    with transaction() as db:
        row = db.get(AgentCredential, token_hash)
        if not row:
            raise ValueError("Credential not found")
        row.revoked_at = now_ms()
        db.add(Audit(kind="agent_credential_revoked", details={"agent_id": row.agent_id}))


def verify(token):
    with transaction() as db:
        row = db.get(AgentCredential, digest(token)) if token else None
        if not row or row.revoked_at is not None or row.expires_at <= now_ms():
            return None
        return CallContext(
            row.agent_id,
            row.token_hash,
            frozenset(row.scopes),
            uid(),
            time.monotonic() + settings.mcp_call_seconds,
        )


def consume_quota(ctx):
    stamp = now_ms()
    with transaction() as db:
        fresh = AgentCredential.quota_start <= stamp - 60000
        result = db.execute(
            update(AgentCredential)
            .where(
                AgentCredential.token_hash == ctx.token_hash,
                AgentCredential.revoked_at.is_(None),
                AgentCredential.expires_at > stamp,
                fresh | (AgentCredential.quota_count < settings.mcp_calls_per_minute),
            )
            .values(
                quota_start=case((fresh, stamp), else_=AgentCredential.quota_start),
                quota_count=case((fresh, 1), else_=AgentCredential.quota_count + 1),
            )
        )
        return result.rowcount == 1


class BearerMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        import asyncio

        headers = dict(scope.get("headers", []))
        authorization = headers.get(b"authorization", b"").decode("latin-1")
        token = (
            authorization[7:]
            if authorization.startswith("Bearer ") and len(authorization) < 1024
            else ""
        )
        identity = await asyncio.to_thread(verify, token)
        if identity is None:
            return await JSONResponse(
                {"error": "invalid_agent_credential"}, 401, headers={"WWW-Authenticate": "Bearer"}
            )(scope, receive, send)
        if not await asyncio.to_thread(consume_quota, identity):
            return await JSONResponse(
                {"error": "agent_request_limit"}, 429, headers={"Retry-After": "60"}
            )(scope, receive, send)
        identity_token = current_identity.set(identity)

        async def watched_receive():
            message = await receive()
            if message["type"] == "http.disconnect":
                identity.cancelled.set()
            return message

        try:
            await self.app(scope, watched_receive, send)
        finally:
            identity.cancelled.set()
            current_identity.reset(identity_token)
