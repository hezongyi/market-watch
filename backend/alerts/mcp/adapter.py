"""Registry -> official SDK schemas and invocation; no business logic in transport."""

import asyncio
import hashlib
import inspect
import json
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context

from fastapi import HTTPException
from mcp.types import CallToolResult, TextContent, Tool, ToolAnnotations
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from ..capabilities.context import CapabilityError
from ..config import settings
from ..storage import AgentCredential, AgentOperation, Audit, now_ms, transaction

logger = logging.getLogger(__name__)


def reauthorize(db, ctx, capability):
    row = db.scalar(
        select(AgentCredential)
        .where(AgentCredential.token_hash == ctx.token_hash)
        .with_for_update()
    )
    if (
        not row
        or row.revoked_at is not None
        or row.expires_at <= now_ms()
        or row.agent_id != ctx.agent_id
        or not capability.scopes <= set(row.scopes)
    ):
        raise CapabilityError("FORBIDDEN", "Credential no longer authorizes this call")


def intent_hash(body):
    return hashlib.sha256(
        json.dumps(
            body.model_dump(mode="json", exclude={"idempotency_key"}),
            sort_keys=True, separators=(",", ":")
        ).encode()
    ).hexdigest()


def write_operation(ctx, capability, body):
    intent = intent_hash(body)
    for attempt in range(2):
        try:
            with transaction() as db:
                reauthorize(db, ctx, capability)
                existing = db.scalar(
                    select(AgentOperation).where(
                        AgentOperation.agent_id == ctx.agent_id,
                        AgentOperation.capability == capability.name,
                        AgentOperation.key == body.idempotency_key,
                    )
                )
                if existing:
                    if existing.intent_hash != intent:
                        raise CapabilityError(
                            "IDEMPOTENCY_CONFLICT", "Same key has a different intent"
                        )
                    result = existing.result
                else:
                    result = capability.output_model.model_validate(
                        capability.handler(ctx, body, db)
                    ).model_dump(mode="json", exclude_unset=True)
                    db.add(
                        AgentOperation(
                            agent_id=ctx.agent_id,
                            capability=capability.name,
                            key=body.idempotency_key,
                            intent_hash=intent,
                            result=result,
                        )
                    )
                db.add(
                    Audit(
                        kind="agent_call",
                        details={
                            "agent_id": ctx.agent_id,
                            "request_id": ctx.request_id,
                            "action": capability.name,
                            "resource": result.get("id"),
                            "result": "ok",
                        },
                    )
                )
                return result
        except IntegrityError:
            # A racing SQLite first insert rolls the entire transaction back.
            # PostgreSQL serializes writes at the credential row above.
            if attempt:
                raise
    raise RuntimeError("unreachable")


def audit(ctx, name, result, resource=None):
    with transaction() as db:
        db.add(
            Audit(
                kind="agent_call",
                details={
                    "agent_id": ctx.agent_id,
                    "request_id": ctx.request_id,
                    "action": name[:80],
                    "resource": resource,
                    "result": result,
                },
            )
        )


def response(data, error=False):
    text = json.dumps(data, ensure_ascii=False, allow_nan=False)
    return CallToolResult(
        content=[TextContent(type="text", text=text)], structured_content=data, is_error=error
    )


class Adapter:
    def __init__(self, registry):
        self.registry = registry
        self.executor = ThreadPoolExecutor(
            max_workers=settings.mcp_concurrency, thread_name_prefix="agent-business"
        )
        self.slots = asyncio.Semaphore(settings.mcp_concurrency)
        self.pending = set()

    async def threaded(self, fn, *args):
        return await asyncio.get_running_loop().run_in_executor(
            self.executor, copy_context().run, fn, *args
        )

    def tools(self, ctx):
        return [
            Tool(
                name=cap.name,
                description=cap.description,
                input_schema=cap.input_model.model_json_schema(),
                output_schema=cap.output_model.model_json_schema(),
                annotations=ToolAnnotations(
                    read_only_hint=cap.effect == "read",
                    destructive_hint=cap.effect == "write",
                    idempotent_hint=True,
                    open_world_hint=cap.name.startswith("market_")
                    or cap.name == "indicators_calculate",
                ),
            )
            for cap in self.registry.visible(ctx.scopes)
        ]

    async def execute(self, ctx, name, arguments):
        from ..provider_cache import CANCELLED, DEADLINE

        cancel_token = CANCELLED.set(ctx.cancelled)
        deadline_token = DEADLINE.set(ctx.deadline)
        try:
            return await self.execute_budgeted(ctx, name, arguments)
        finally:
            CANCELLED.reset(cancel_token)
            DEADLINE.reset(deadline_token)

    async def execute_budgeted(self, ctx, name, arguments):
        async with self.slots:
            try:
                if time.monotonic() >= ctx.deadline or ctx.cancelled.is_set():
                    raise CapabilityError("DEADLINE_EXCEEDED", "Call budget expired", True)
                cap = self.registry.resolve(name, ctx.scopes)
                body = cap.input_model.model_validate(arguments)
                if cap.effect == "write":
                    return response(await self.threaded(write_operation, ctx, cap, body))

                def authorize_read():
                    with transaction() as db:
                        reauthorize(db, ctx, cap)

                await self.threaded(authorize_read)
                result = (
                    await cap.handler(ctx, body)
                    if inspect.iscoroutinefunction(cap.handler)
                    else await self.threaded(cap.handler, ctx, body)
                )
                data = cap.output_model.model_validate(result).model_dump(
                    mode="json", exclude_unset=True
                )
                await self.threaded(
                    audit,
                    ctx,
                    name,
                    "ok",
                    arguments.get("instrument") or arguments.get("workspace_id"),
                )
                return response(data)
            except ValidationError as exc:
                error = CapabilityError(
                    "INVALID_ARGUMENT",
                    "Invalid capability input or output",
                    context={"fields": [".".join(map(str, e["loc"])) for e in exc.errors()]},
                )
            except CapabilityError as exc:
                error = exc
            except HTTPException as exc:
                code = {
                    404: "DATA_UNAVAILABLE",
                    409: "BUSINESS_CONFLICT",
                    422: "INVALID_ARGUMENT",
                    503: "DATA_UNAVAILABLE",
                }.get(exc.status_code, "BUSINESS_ERROR")
                detail = exc.detail
                message = detail.get("message", code) if isinstance(detail, dict) else str(detail)
                error = CapabilityError(code, message, exc.status_code >= 500)
            except (TimeoutError, asyncio.CancelledError):
                error = CapabilityError(
                    "DEADLINE_EXCEEDED", "Call cancelled or budget expired", True
                )
            except Exception:
                logger.exception("Agent capability failed: %s", name[:80])
                error = CapabilityError("INTERNAL_ERROR", "Capability failed")
            await self.threaded(audit, ctx, name, error.code)
            return response({"error": error.result()}, True)

    async def call(self, ctx, name, arguments):
        # Do not free compute slots while detached synchronous work still runs.
        if len(self.pending) >= settings.mcp_concurrency * 2:
            return response(
                {
                    "error": CapabilityError(
                        "RESOURCE_LIMIT", "Concurrent call limit", True
                    ).result()
                },
                True,
            )
        task = asyncio.create_task(self.execute(ctx, name, arguments))
        self.pending.add(task)
        task.add_done_callback(self.pending.discard)
        try:
            return await asyncio.wait_for(
                asyncio.shield(task), max(0.01, ctx.deadline - time.monotonic())
            )
        except TimeoutError:
            ctx.cancelled.set()
            return response(
                {
                    "error": CapabilityError(
                        "DEADLINE_EXCEEDED", "Call budget expired", True
                    ).result()
                },
                True,
            )
        except asyncio.CancelledError:
            ctx.cancelled.set()
            raise

    async def close(self):
        if self.pending:
            await asyncio.gather(*tuple(self.pending), return_exceptions=True)
        self.executor.shutdown(wait=True)
