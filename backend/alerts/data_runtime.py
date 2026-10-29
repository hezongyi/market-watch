"""Fixed profile for historical preparation and demand-bound chart work."""

import argparse
import hashlib
from contextlib import contextmanager

from sqlalchemy import text

from . import runtime_health
from .runtime_supervisor import Loop, RuntimeGroupError, exit_if_unstopped, run_group


def build_loops():
    from . import (
        chart_aggregation_worker,
        history_versions,
        market_stream_worker,
        native_history_loads,
        provider_cache,
        provider_service,
        provider_transport,
        switch_schedule,
    )
    from .provider_capabilities import enabled_sources

    providers = tuple(
        loop
        for source in enabled_sources()
        for loop in (
            Loop(f"provider_live_{source}", lambda stop, source=source: provider_service.run_live(stop, source)),
            Loop(f"provider_warm_{source}", lambda stop, source=source: provider_service.run_warm(stop, source)),
        )
    )
    transports = tuple(
        Loop(f"provider_transport_{source}",
             lambda stop, source=source: provider_transport.run(
                 stop, provider_cache.interactive_busy, source))
        for source in provider_transport.ORIGINS
    )
    return providers + transports + (
        Loop("provider_janitor", provider_service.run_janitor),
        Loop("chart_history", _chart_history),
        Loop("history_network", history_versions.run_network),
        Loop("history_compute", history_versions.run_compute),
        Loop("native_history", native_history_loads.run),
        Loop("chart_aggregation", chart_aggregation_worker.run),
        Loop("market_stream", market_stream_worker.run),
        # The weekly switch window and its bounded cleanup are data work: the
        # shadow pass prepares candidates, the retention pass drains one batch
        # inside this profile's ownership lock.
        Loop("switch_shadow", switch_schedule.run_shadow),
        Loop("retention", switch_schedule.run_retention),
    )


def _chart_history(stop):
    from contextlib import ExitStack

    import httpx

    from . import chart_history_worker
    from .config import settings
    from .market import fetch_source
    from .providers import fetch_binance, fetch_oanda

    with ExitStack() as stack:
        clients = {"oanda": stack.enter_context(httpx.Client(
            timeout=15, proxy=settings.oanda_proxy or None, trust_env=False))}

        def fetch(source, symbol, start, end):
            provider = {"oanda": fetch_oanda, "binance": fetch_binance}.get(source)
            if provider is None:
                return fetch_source(source, symbol, start, end)
            return provider(symbol, start, end, client=clients.get(source))

        chart_history_worker.run(fetch, stop)


@contextmanager
def ownership(engine):
    from .config import settings

    if engine.dialect.name != "postgresql":
        raise RuntimeError("Runtime profiles require PostgreSQL ownership")
    lock_id = int.from_bytes(hashlib.sha256(
        f"data-runtime:{settings.runtime_deployment}".encode()).digest()[:8], "big", signed=True)
    with engine.connect() as connection:
        acquired = connection.scalar(text("SELECT pg_try_advisory_lock(:key)"), {"key": lock_id})
        connection.commit()
        if not acquired:
            raise RuntimeError("Another data-runtime owns this deployment")
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
                connection.invalidate()


def run(*, stop=None, handle_signals=True):
    from .akshare_catalog import seed as seed_akshare
    from .config import settings
    from .provider_chart import warm_clients
    from .storage import bootstrap, engine
    from .swing_sr import register_indicator
    from .yahoo_catalog import seed as seed_yahoo

    if settings.oanda_native_latest_owner != "provider":
        raise ValueError("Runtime profiles require ALERTS_OANDA_NATIVE_LATEST_OWNER=provider")
    register_indicator()
    bootstrap()
    selected = build_loops()
    with ownership(engine) as verify_ownership:
        warm_clients()
        seed_yahoo()
        seed_akshare()
        selected += (Loop("data_ownership", verify_ownership),)
        boot_id = runtime_health.boot()
        reporters = {
            loop.role: runtime_health.Progress(
                "data", loop.role, boot_id,
                deadline_ms=(
                    300_000 if loop.role in {
                        "chart_history", "history_network", "history_compute", "native_history", "market_stream",
                        "chart_aggregation", "switch_shadow", "retention",
                    }
                    else 90_000
                ),
            )
            for loop in selected
        }
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
                from .provider_transport import close_clients

                close_clients()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    run()


if __name__ == "__main__":
    main()
