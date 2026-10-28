"""Progress written by actual runtime loops, with fenced per-role records."""

import logging
import threading
import uuid
from contextlib import contextmanager
from contextvars import ContextVar

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from .config import settings
from .storage import Preference, now_ms, transaction

log = logging.getLogger(__name__)
CURRENT = ContextVar("runtime_progress", default=None)
WRITE_MS = 5000
STALE_MS = 15000
STARTUP_MS = 60000
MARKET_ROLES = ("pricing", "realtime", "composite_aggregate", "alert_indicator",
                "chart_alert", "market_ownership")


def data_roles():
    from .provider_capabilities import enabled_sources
    from .provider_transport import ORIGINS

    providers = tuple(role for source in enabled_sources()
                      for role in (f"provider_live_{source}", f"provider_warm_{source}"))
    transports = tuple(f"provider_transport_{source}" for source in ORIGINS)
    return providers + transports + ("provider_janitor", "chart_history",
                        "history_network", "history_compute", "native_history", "chart_aggregation",
                        "market_stream", "data_ownership")


def key(role):
    return f"worker_health:runtime:{settings.runtime_deployment}:{role}"


class Progress:
    """A boot owns its record until the next owner replaces it under a group lock.

    Updates lock and compare the stored boot ID in the same transaction. A late
    completion from a former boot cannot overwrite the replacement's record.
    This fences health writes; task publication still uses its existing leases.
    """

    def __init__(self, group, role, boot_id, *, deadline_ms=STALE_MS):
        self.group, self.role, self.boot_id = group, role, boot_id
        self.deadline_ms = deadline_ms
        self.saved_at, self.saved_signature = None, None
        self.lock = threading.Lock()

    def claim(self):
        stamp = now_ms()
        with transaction() as db:
            insert = pg_insert if db.get_bind().dialect.name == "postgresql" else sqlite_insert
            db.execute(insert(Preference).values(key=key(self.role), value={})
                       .on_conflict_do_nothing(index_elements=["key"]))
            row = db.scalar(select(Preference).where(Preference.key == key(self.role)).with_for_update())
            previous = row.value
            starts = [at for at in previous.get("starts", []) if at > stamp - 300000][-9:]
            row.value = dict(group=self.group, role=self.role,
                deployment=settings.runtime_deployment, boot_id=self.boot_id,
                started_at=stamp, starts=[*starts, stamp], state="starting",
                checked_at=None, last_success_at=None, error_type=None,
                stale_after_ms=self.deadline_ms)

    def record(self, *, state="idle", error=None, completed=True, watermark=None):
        stamp = now_ms()
        error_type = type(error).__name__ if isinstance(error, BaseException) else error
        signature = state, error_type
        with self.lock:
            if (self.saved_at is not None and signature == self.saved_signature
                    and stamp - self.saved_at < WRITE_MS):
                return
            with transaction() as db:
                row = db.scalar(select(Preference).where(
                    Preference.key == key(self.role)).with_for_update())
                if not row or row.value.get("boot_id") != self.boot_id:
                    return
                value = dict(row.value, state=state)
                # A retry beginning is neither a completed check nor recovery.
                if completed:
                    value["checked_at"] = stamp
                    if state == "waiting_input" and error_type is None:
                        error_type = row.value.get("error_type")
                    value["error_type"] = error_type
                    if not error_type:
                        value["last_success_at"] = stamp
                    if watermark is not None:
                        value["watermark"] = watermark
                elif error_type:
                    value["error_type"] = error_type
                row.value = value
            self.saved_at, self.saved_signature = stamp, signature


class RuntimeOwnershipLost(RuntimeError):
    """Raised when this loop's boot has been replaced by a new owner."""


def assert_current(db):
    """Fence a business transaction against a newer runtime boot."""
    reporter = CURRENT.get()
    if reporter is None:
        return
    row = db.scalar(select(Preference).where(
        Preference.key == key(reporter.role)).with_for_update())
    if not row or row.value.get("boot_id") != reporter.boot_id:
        raise RuntimeOwnershipLost(f"Runtime ownership lost for {reporter.role}")


def progress(*, state="idle", error=None, completed=True, watermark=None):
    reporter = CURRENT.get()
    if reporter is not None:
        try:
            reporter.record(state=state, error=error, completed=completed, watermark=watermark)
        except Exception as exc:
            # Leave the persisted timestamp unchanged when PG is unavailable.
            log.warning("runtime_progress_unavailable role=%s type=%s",
                        reporter.role, type(exc).__name__)


@contextmanager
def reporting(reporter):
    token = CURRENT.set(reporter)
    try:
        yield
    finally:
        CURRENT.reset(token)


def summary(db, roles=MARKET_ROLES, *, at=None):
    stamp = now_ms() if at is None else at
    result = []
    for role in roles:
        row = db.get(Preference, key(role))
        value = dict(row.value) if row else {"role": role, "state": "missing"}
        if row:
            checked = value.get("checked_at")
            if checked is None:
                if stamp - value["started_at"] >= STARTUP_MS:
                    value["state"] = "stale"
            elif stamp - checked >= value["stale_after_ms"]:
                value["state"] = "stale"
        result.append(value)
    return result


def boot():
    return str(uuid.uuid4())
