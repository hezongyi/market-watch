"""Fixed runtime profile for self-built realtime ingestion and ChartAlerts."""

import hashlib
from contextlib import contextmanager, nullcontext

from sqlalchemy import text

from . import runtime_health
from .runtime_supervisor import Loop, RuntimeGroupError, exit_if_unstopped, run_group


def build_loops():
    from . import (
        alert_indicator_worker,
        alert_monitor,
        composite_aggregate_worker,
        oanda_worker,
        realtime_worker,
    )
    from .config import settings

    loops = [
        Loop("pricing", oanda_worker.run_service),
        Loop("realtime", realtime_worker.run),
        Loop("composite_aggregate", composite_aggregate_worker.run),
        Loop("alert_indicator", alert_indicator_worker.run),
    ]
    if settings.market_runtime_chart_alert_enabled:
        loops.append(Loop("chart_alert", alert_monitor.run))
    return tuple(loops)


@contextmanager
def ownership(engine):
    """One market scheduler per database/deployment; tasks keep their own fences.

    This reserves one database connection, included in the runtime pool budget.
    Health writes additionally compare boot IDs to reject late old completions.
    """
    if engine.dialect.name != "postgresql":
        raise RuntimeError("Runtime profiles require PostgreSQL ownership")
    from .config import settings

    lock_id = int.from_bytes(hashlib.sha256(
        f"market-runtime:{settings.runtime_deployment}".encode()).digest()[:8], "big", signed=True)
    with engine.connect() as connection:
        acquired = connection.scalar(text("SELECT pg_try_advisory_lock(:key)"), {"key": lock_id})
        connection.commit()
        if not acquired:
            raise RuntimeError("Another market-runtime owns this deployment")
        try:
            def check(stop):
                while not stop.is_set():
                    connection.execute(text("SELECT 1"))
                    connection.commit()
                    runtime_health.progress()
                    stop.wait(5)

            yield check
        finally:
            try:
                connection.execute(text("SELECT pg_advisory_unlock(:key)"), {"key": lock_id})
                connection.commit()
            except Exception:
                # A lost session releases the server-side lock automatically.
                connection.invalidate()


@contextmanager
def chart_alert_ownership(engine):
    """Ensure the chart-alert loop has exactly one owner across profiles."""
    from .config import settings

    lock_id = int.from_bytes(hashlib.sha256(
        f"chart-alert-runtime:{settings.runtime_deployment}".encode()).digest()[:8],
        "big", signed=True)
    with engine.connect() as connection:
        acquired = connection.scalar(text("SELECT pg_try_advisory_lock(:key)"), {"key": lock_id})
        connection.commit()
        if not acquired:
            raise RuntimeError("Another ChartAlert runtime owns this deployment")
        try:
            yield
        finally:
            try:
                connection.execute(text("SELECT pg_advisory_unlock(:key)"), {"key": lock_id})
                connection.commit()
            except Exception:
                connection.invalidate()


def run(*, stop=None, loops=None, handle_signals=True):
    from . import provider_transport
    from .config import settings
    from .storage import bootstrap, engine
    from .swing_sr import register_indicator

    if settings.oanda_native_latest_owner != "provider":
        raise ValueError("Runtime profiles require ALERTS_OANDA_NATIVE_LATEST_OWNER=provider")
    register_indicator()
    bootstrap()
    selected = tuple(loops or build_loops())
    alert_scope = (chart_alert_ownership(engine)
                   if any(loop.role == "chart_alert" for loop in selected) else nullcontext())
    # Acquire every required lock before publishing any new boot identity.
    with ownership(engine) as verify_ownership, alert_scope:
        selected += (Loop("market_ownership", verify_ownership),)
        boot_id = runtime_health.boot()
        reporters = {loop.role: runtime_health.Progress(
            "market", loop.role, boot_id,
            deadline_ms=60000 if loop.role == "realtime" else runtime_health.STALE_MS,
        ) for loop in selected}
        for reporter in reporters.values():
            reporter.claim()

        def wrapped(loop):
            def execute(shared_stop):
                with runtime_health.reporting(reporters[loop.role]):
                    loop.run(shared_stop)
            return Loop(loop.role, execute)

        def state(role, value, error):
            reporters[role].record(state=value, error=error, completed=False)

        safe_to_close = True
        try:
            run_group(tuple(map(wrapped, selected)), stop=stop, on_state=state,
                      handle_signals=handle_signals)
        except RuntimeGroupError as error:
            safe_to_close = not error.alive
            exit_if_unstopped(error)
            raise
        finally:
            if safe_to_close:
                provider_transport.close_clients()
