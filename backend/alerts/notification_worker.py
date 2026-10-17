"""Async projector for the unified notification center (Issue #75).

Runs beside the API. Reads committed source audits that have no processing
claim, projects them idempotently and appends the change log. It never calls
alert evaluation or mobile delivery, so a crashed/restarted projector cannot
re-trigger business actions.
"""

from __future__ import annotations

import signal
import sys
import time

from .notification_center import project_pending, prune
from .storage import Preference, bootstrap, now_ms, transaction

PRUNE_INTERVAL_MS = 60 * 60 * 1000
HEARTBEAT_KEY = "notification.projector.heartbeat"
HEARTBEAT_STALE_MS = 120_000


def heartbeat_age() -> int | None:
    with transaction() as db:
        row = db.get(Preference, HEARTBEAT_KEY)
        if not row or not isinstance(row.value, dict):
            return None
        return now_ms() - int(row.value.get("at") or 0)


def beat() -> None:
    with transaction() as db:
        row = db.get(Preference, HEARTBEAT_KEY)
        value = {"at": now_ms()}
        if row is None:
            db.add(Preference(key=HEARTBEAT_KEY, value=value))
        else:
            row.value = value


def run(once: bool = False) -> int:
    bootstrap()
    stopping = False

    def stop(*_):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    if "--check" in sys.argv[1:]:
        age = heartbeat_age()
        print({"projector_age_ms": age, "stale": age is None or age > HEARTBEAT_STALE_MS})
        return 0 if age is not None and age <= HEARTBEAT_STALE_MS else 1
    last_prune = 0
    projected = 0
    while not stopping:
        try:
            beat()
            count = project_pending(100)
            projected += count
            if once:
                return projected
            if now_ms() - last_prune > PRUNE_INTERVAL_MS:
                last_prune = now_ms()
                prune()
            time.sleep(0.2 if count else 1.0)
        except Exception as exc:  # noqa: BLE001 - keep the worker alive and retrying
            print(f"notification projector error: {type(exc).__name__}: {exc}",
                  file=sys.stderr, flush=True)
            time.sleep(2)
    return projected


def main() -> None:
    once = "--once" in sys.argv[1:]
    run(once=once)


if __name__ == "__main__":
    main()
