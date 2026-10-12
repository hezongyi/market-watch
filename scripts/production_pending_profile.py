"""Acceptance-only ASGI timing wrapper; never imported by the product API.

Run through a read-only bind in this task's isolated Compose API service.
No query text, parameters, identifiers or payloads enter the timing headers.
"""
import contextvars
import functools
import os
import resource
import sys
import time

from sqlalchemy import event
from sqlalchemy.engine import Engine, make_url

from alerts.config import settings

url = make_url(settings.database_url)
if (os.environ.get("MW_PENDING_ACCEPTANCE_TASK") != "mw-pending-fixes-20261013"
        or url.host != "pg" or url.database != "production_ux_acceptance"
        or settings.delivery_enabled or settings.oanda_token or settings.yahoo_enabled):
    raise RuntimeError("Requires task-local synthetic acceptance configuration")

metrics = contextvars.ContextVar("pending_acceptance_metrics", default=None)


@event.listens_for(Engine, "before_cursor_execute")
def before_sql(conn, cursor, statement, parameters, context, executemany):
    if metrics.get() is not None:
        context._pending_profile_started = time.perf_counter()


@event.listens_for(Engine, "after_cursor_execute")
def after_sql(conn, cursor, statement, parameters, context, executemany):
    record = metrics.get()
    if record is not None and hasattr(context, "_pending_profile_started"):
        record["sql"] += time.perf_counter() - context._pending_profile_started
        record["queries"] += 1


def measured_calculation(function):
    @functools.wraps(function)
    def wrapped(*args, **kwargs):
        record = metrics.get()
        if record is None:
            return function(*args, **kwargs)
        wall, cpu = time.perf_counter(), time.thread_time()
        try:
            return function(*args, **kwargs)
        finally:
            record["calculation"] += time.perf_counter() - wall
            record["calculation_cpu"] += time.thread_time() - cpu
            record["calculations"] += 1
    return wrapped


# Both consumers hold module-level imports of the same calculation function.
from alerts import chart_api, provider_cache  # noqa: E402
chart_api.calculate = measured_calculation(chart_api.calculate)
provider_cache.calculate = measured_calculation(provider_cache.calculate)

if os.environ.get("MW_PENDING_PIN_SYNTHETIC_SOURCE") == "true":
    # A task-only fixture may never silently mix cached invented bars with
    # live provider observations during a comparison. Real reads, preparation,
    # PostgreSQL and Python calculation stay unchanged; a cache miss fails.
    fetch_page = provider_cache.fetch_page

    def pinned_fetch(key, meta, *args, **kwargs):
        if meta.get("symbol") == "BTCUSDT" and provider_cache.READ_MODE.get() != "cache":
            raise RuntimeError(f"Pinned synthetic acceptance source cache miss: {args[:3]}")
        return fetch_page(key, meta, *args, **kwargs)

    provider_cache.fetch_page = pinned_fetch

if "--native-worker" in sys.argv:
    from alerts.native_history_loads import main
    main()
    raise SystemExit(0)

from alerts.api import app  # noqa: E402

if os.environ.get("MW_PENDING_SYNTHETIC_CLOCK"):
    # Price readers and the public server clock see the same fixed fixture
    # instant. Monotonic deadlines and actual CPU/wall timings still advance.
    # This avoids requesting the real provider beyond the synthetic source end.
    from alerts import api
    fixture_time = int(os.environ["MW_PENDING_SYNTHETIC_CLOCK"])
    provider_cache.now_ms = lambda: fixture_time
    api.now_ms = lambda: fixture_time


async def profiled(scope, receive, send):
    if scope["type"] != "http" or not scope["path"].startswith("/api/charts/"):
        return await app(scope, receive, send)
    record = dict(sql=0.0, queries=0, calculation=0.0, calculation_cpu=0.0, calculations=0)
    token = metrics.set(record)
    started = time.perf_counter()

    async def timed_send(message):
        if message["type"] == "http.response.start":
            values = {
                "backend": (time.perf_counter() - started) * 1000,
                "sql": record["sql"] * 1000,
                "calculation": record["calculation"] * 1000,
                "calculation_cpu": record["calculation_cpu"] * 1000,
            }
            timing = ", ".join(f"{key};dur={value:.3f}" for key, value in values.items())
            message = {**message, "headers": [*message.get("headers", []),
                (b"server-timing", timing.encode("ascii")),
                (b"x-mw-acceptance-queries", str(record["queries"]).encode("ascii")),
                (b"x-mw-acceptance-calculations", str(record["calculations"]).encode("ascii")),
                (b"x-mw-acceptance-api-peak-rss-kib", str(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss).encode("ascii"))]}
        await send(message)
    try:
        await app(scope, receive, timed_send)
    finally:
        metrics.reset(token)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(profiled, host="0.0.0.0", port=8000, access_log=False)
