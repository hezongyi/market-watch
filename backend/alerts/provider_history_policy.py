"""Optional native history budgets; mandatory demand never depends on these."""

# The default stays compatible; candidates must explicitly configure capacity.
CAPACITY = 20000


def capacity():
    from .config import settings
    return settings.native_history_max_bars


def capabilities():
    import hashlib
    import json

    from .config import settings
    values = {
        "max_bars": capacity(), "workspace_bars": settings.native_history_workspace_bars,
        "response_bytes": settings.native_history_response_bytes,
        "task_seconds": settings.native_history_task_seconds,
        "max_pages": settings.native_history_task_pages, "max_inflight": 8,
        "mode": "continuous", "protocol": 1,
    }
    return {**values, "version": hashlib.sha256(json.dumps(values, sort_keys=True).encode()).hexdigest()[:16]}


class CapacityExceeded(ValueError):
    code = "NATIVE_HISTORY_CAPACITY_EXCEEDED"


def optional_bars(context, demand, prefix, *, hot, first, enabled, python=False,
                  cold_extra=400, first_extra=2000, history_extra=2000):
    if not enabled or python:
        return 0
    budget = 4000 if context.chart_count == 1 else 2000
    amount = (first_extra if first and not context.historical_navigation else history_extra) if hot else cold_extra
    if context.screen_bars is not None:
        amount = min(amount, context.screen_bars * context.batch_screens)
    if context.chart_count > 1:
        amount = min(amount, 1000)
    if context.chart_count >= 4 and context.focused is False:
        amount = 0
    return min(amount, max(0, budget - demand), max(0, capacity() - demand - prefix))
