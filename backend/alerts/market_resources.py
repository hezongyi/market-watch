"""Cross-process upstream slots and request-rate reservation.

Five requests per second per source: two reserved for realtime, two for
interactive charts, one for backfill/quotes. Leases expire after worker failure. Transactions
only acquire/release tokens; no connection or writer lock spans network I/O.
"""

import time
from contextlib import contextmanager
from contextvars import ContextVar

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from .storage import ImportJob, Preference, now_ms, transaction, uid

LANE = ContextVar("market_resource_lane", default=None)


@contextmanager
def lane(kind):
    token = LANE.set(kind)
    try:
        yield
    finally:
        LANE.reset(token)


def acquire(source, kind, now):
    key = "upstream_slots:" + source
    token = uid()
    with transaction() as db:
        insert = pg_insert if db.get_bind().dialect.name == "postgresql" else sqlite_insert
        db.execute(
            insert(Preference.__table__)
            .values(key=key, value={})
            .on_conflict_do_nothing(index_elements=["key"])
        )
        row = db.scalar(select(Preference).where(Preference.key == key).with_for_update())
        values = row.value
        active = [entry for entry in values.get("active", []) if entry["expires"] > now]
        requests = [entry for entry in values.get("requests", []) if entry["at"] > now - 1000]
        capacity = 2 if kind in ("realtime", "chart") else 1
        repair = kind == "history" and db.scalar(
            select(ImportJob.id)
            .where(ImportJob.priority == 0, ImportJob.status.in_(["pending", "running"]))
            .limit(1)
        )
        allowed = (
            not repair
            and sum(e["kind"] == kind for e in active) < capacity
            and sum(e["kind"] == kind for e in requests) < capacity
        )
        if not allowed:
            return None
        active.append(dict(token=token, kind=kind, expires=now + 90000))
        requests.append(dict(kind=kind, at=now))
        row.value = dict(active=active, requests=requests)
    return token


def release(source, token):
    with transaction() as db:
        row = db.scalar(
            select(Preference).where(Preference.key == "upstream_slots:" + source).with_for_update()
        )
        if row:
            row.value = {
                **row.value,
                "active": [e for e in row.value.get("active", []) if e["token"] != token],
            }


@contextmanager
def request_slot(source, *, deadline=None, cancelled=None):
    kind = LANE.get()
    # Native adapters remain independently testable. Runtime owners set a lane
    # before entering an upstream fetch, including provider chart cache misses.
    if kind is None:
        yield
        return
    deadline = deadline or time.monotonic() + (15 if kind == "realtime" else 23)
    token = None
    while time.monotonic() < deadline:
        if cancelled and cancelled():
            raise TimeoutError("后台额度等待已让位于前台请求")
        token = acquire(source, kind, now_ms())
        if token:
            break
        time.sleep(0.1)
    if token is None:
        raise TimeoutError("上游保留额度繁忙，请稍后重试")
    try:
        yield
    finally:
        release(source, token)
