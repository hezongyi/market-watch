"""Persistent demands executed one provider page per leased worker turn.

Consumers own handles, datasets own committed pages. A cancelled consumer never
releases another consumer's dataset lease or removes its completed history.
"""
import hashlib
import json
import logging
import time
from contextlib import contextmanager

from fastapi import HTTPException
from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError

from . import provider_cache as cache
from .config import settings
from .provider_history_policy import CapacityExceeded, capacity
from .storage import NativeHistoryLoad, now_ms, transaction, uid

log = logging.getLogger(__name__)
ACTIVE = ("waiting", "filling", "ready")


def error(code, message, status=503):
    return {"code": code, "message": message, "status": status, "history_boundary": False}


def owner_of(request):
    return hashlib.sha256(request.cookies.get("session", "").encode()).hexdigest()


def admit(body):
    from .chart_indicators import history_requirement, validate
    if body.series_kind != "provider" or body.native_history is None or body.native_reserve:
        raise HTTPException(422, error("INVALID_HISTORY_REQUEST", "历史任务只支持原生平台需求", 422))
    for spec in body.indicators:
        validate(spec)
    prefix = max((history_requirement(spec) for spec in body.indicators), default=0)
    limit = capacity()
    required = max(body.limit, body.count_back or 0) + prefix
    if required > limit:
        raise CapacityExceeded(f"历史请求及指标前缀需要 {required:,} 根，上限 {limit:,} 根。请在汉堡菜单 → 历史数据容量中调整，或提高周期、减小跨度")


@contextmanager
def read_context(mode, deadline, progress=None, valid=None):
    tokens = [(cache.READ_MODE, cache.READ_MODE.set(mode)),
              (cache.DEADLINE, cache.DEADLINE.set(deadline)),
              (cache.PAGE_PROGRESS, cache.PAGE_PROGRESS.set(progress)),
              (cache.WORK_VALID, cache.WORK_VALID.set(valid))]
    try:
        yield
    finally:
        for variable, token in reversed(tokens):
            variable.reset(token)


def read_cached(body):
    with read_context("cache", time.monotonic() + settings.provider_request_seconds):
        result = cache.data(body)
    # The final snapshot is bounded in bars and in serialized bytes, including
    # indicator series. Neither overflow can masquerade as an exhausted market.
    size = len(json.dumps(result, separators=(",", ":"), ensure_ascii=False).encode())
    if size > settings.native_history_response_bytes:
        raise CapacityExceeded("历史结果超过传输预算，请提高周期或减小跨度")
    return result


def public(row):
    return {"id": row.id, "state": row.state, "pages": row.pages,
            "deadline": row.deadline, "error": row.error_json}


def owned(db, owner, ident):
    row = db.scalar(select(NativeHistoryLoad).where(
        NativeHistoryLoad.id == ident, NativeHistoryLoad.owner == owner).with_for_update())
    if row is None:
        raise HTTPException(404, error("HISTORY_NOT_FOUND", "历史加载已结束或不存在", 404))
    return row


def refresh(row):
    if row.state in ACTIVE and (row.deadline <= now_ms() or row.consumer_until <= now_ms()):
        row.state = "expired"
        row.error_json = error("HISTORY_TIMEOUT", "历史等待已过期，请重试")
    if row.state in ACTIVE:
        row.consumer_until = min(row.deadline, now_ms() + 45000)


def submit(owner, request_id, body):
    admit(body)
    query = body.model_dump(by_alias=True, mode="json")
    with transaction() as db:
        old = db.scalar(select(NativeHistoryLoad).where(
            NativeHistoryLoad.owner == owner, NativeHistoryLoad.request_id == request_id))
        if old:
            if old.query_json != query:
                raise HTTPException(409, error("INVALID_HISTORY_REQUEST", "请求标识已用于另一需求", 409))
            refresh(old)
            return {"load": public(old)}
    try:
        return {"result": read_cached(body)}
    except cache.HistoryPending:
        pass
    with transaction() as db:
        # Serialize admission for the same authenticated owner using the
        # existing login session row; an empty cookie cannot reach this route.
        from .storage import LoginSession
        db.scalar(select(LoginSession).where(LoginSession.token_hash == owner).with_for_update())
        count = db.scalar(select(func.count()).select_from(NativeHistoryLoad).where(
            NativeHistoryLoad.owner == owner, NativeHistoryLoad.state.in_(ACTIVE),
            NativeHistoryLoad.deadline > now_ms(), NativeHistoryLoad.consumer_until > now_ms()))
        if count >= settings.native_history_tasks_per_owner:
            raise HTTPException(503, error("HISTORY_BUSY", "历史加载任务繁忙，请稍后重试"))
        row = NativeHistoryLoad(id=uid(), owner=owner, request_id=request_id, query_json=query,
                                state="waiting", deadline=now_ms()+settings.native_history_task_seconds*1000,
                                consumer_until=now_ms()+45000)
        db.add(row)
        try:
            db.flush()
        except IntegrityError:
            db.rollback()
            with transaction() as other:
                existing = other.scalar(select(NativeHistoryLoad).where(
                    NativeHistoryLoad.owner == owner, NativeHistoryLoad.request_id == request_id))
                if existing is None or existing.query_json != query:
                    raise HTTPException(409, error("INVALID_HISTORY_REQUEST", "请求标识冲突", 409))
                return {"load": public(existing)}
        return {"load": public(row)}


def status(owner, ident, cancel=False):
    with transaction() as db:
        row = owned(db, owner, ident)
        refresh(row)
        if cancel and row.state in ACTIVE:
            row.state = "cancelled"
            row.generation += 1
            row.error_json = error("HISTORY_CANCELLED", "已取消历史加载", 409)
        return public(row)


def result(owner, ident):
    from .chart_api import DataQuery
    with transaction() as db:
        row = owned(db, owner, ident)
        refresh(row)
        if row.state != "ready":
            return {"load": public(row)}
        body = DataQuery.model_validate(row.query_json)
    # Ready is coverage, never a cached JSON/version. Re-read the latest
    # coherent observation; a concurrent cache invalidation returns to filling.
    try:
        value = read_cached(body)
    except cache.HistoryPending:
        with transaction() as db:
            row = owned(db, owner, ident)
            if row.state == "ready":
                row.state = "waiting"
            return {"load": public(row)}
    status_now = status(owner, ident)
    if status_now["state"] != "ready":
        return {"load": status_now}
    return {"result": value}


def once():
    from .chart_api import DataQuery
    from .market_resources import lane
    with transaction() as db:
        now = now_ms()
        db.execute(update(NativeHistoryLoad).where(NativeHistoryLoad.state.in_(ACTIVE),
            ((NativeHistoryLoad.deadline <= now) | (NativeHistoryLoad.consumer_until <= now)))
            .values(state="expired", error_json=error("HISTORY_TIMEOUT", "历史等待已过期，请重试")))
        row = db.scalar(select(NativeHistoryLoad).where(
            NativeHistoryLoad.state.in_(("waiting", "filling")),
            NativeHistoryLoad.lease_until <= now).order_by(NativeHistoryLoad.pages + NativeHistoryLoad.stalls, NativeHistoryLoad.created_at)
            .limit(1).with_for_update(skip_locked=True))
        if row is None:
            db.execute(delete(NativeHistoryLoad).where(NativeHistoryLoad.deadline < now-3600000,
                                                       NativeHistoryLoad.lease_until <= now))
            return False
        row.state = "filling"
        row.generation += 1
        row.lease_until = now + int(settings.provider_request_seconds*1000) + 5000
        ident, generation, query = row.id, row.generation, row.query_json
        pages, stalls = row.pages, row.stalls
    def valid():
        with transaction() as db:
            return bool(db.scalar(select(NativeHistoryLoad.id).where(
                NativeHistoryLoad.id == ident, NativeHistoryLoad.generation == generation,
                NativeHistoryLoad.state == "filling", NativeHistoryLoad.lease_until > now_ms(),
                NativeHistoryLoad.consumer_until > now_ms(), NativeHistoryLoad.deadline > now_ms())))
    progress = {"attempts": 0, "pages": 0, "advanced": False}
    state, failure = "waiting", None
    try:
        if pages >= settings.native_history_task_pages:
            try:
                read_cached(DataQuery.model_validate(query))
                state = "ready"
            except cache.HistoryPending:
                raise CapacityExceeded("历史分页超过任务预算，请减小跨度") from None
        else:
            state = "filling"
        if state != "ready":
            with read_context("step", time.monotonic()+settings.provider_request_seconds, progress, valid), lane("chart"):
                cache.data(DataQuery.model_validate(query))
            state = "ready"
    except cache.HistoryPending:
        state = "waiting"
        if not progress["advanced"] and stalls >= 2:
            state, failure = "failed", error("HISTORY_NO_PROGRESS", "历史分页未推进，请重试")
    except CapacityExceeded as exc:
        state, failure = "failed", error(exc.code, str(exc), 422)
    except TimeoutError:
        if not progress["pages"] and stalls >= 2:
            state, failure = "failed", error("HISTORY_TIMEOUT", "历史分页暂时未推进，请重试")
    except Exception as exc:
        log.warning("History page failed type=%s", type(exc).__name__)
        state, failure = "failed", error("HISTORY_PROVIDER_FAILED", "平台历史暂不可用，请重试")
    with transaction() as db:
        db.execute(update(NativeHistoryLoad).where(
            NativeHistoryLoad.id == ident, NativeHistoryLoad.generation == generation,
            NativeHistoryLoad.state == "filling", NativeHistoryLoad.lease_until > now_ms())
            .values(state=state, error_json=failure, lease_until=0, pages=pages+progress["pages"],
                    stalls=0 if progress["advanced"] else stalls+1))
    return True


def main():
    from .composite_price_confirmation import once as confirm_price
    from .provider_chart import warm_clients
    from .worker_health import Pulse

    pulse = Pulse("native_history")
    logging.basicConfig(level=logging.INFO)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    warm_clients()
    while True:
        try:
            pulse.start()
            confirmed = confirm_price()
            worked = once()
            worked = worked or confirmed
            pulse.finish(worked=worked)
        except Exception as exc:
            pulse.finish(errors=[type(exc).__name__])
            log.warning("History worker turn failed type=%s", type(exc).__name__)
            worked = False
        time.sleep(0.05 if worked else 1)


if __name__ == "__main__":
    main()
