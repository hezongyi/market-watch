"""Optional native history budgets; mandatory demand never depends on these."""

CAPACITY_KEY = "advanced:history-capacity:v1"
MIN_CAPACITY = 20000


def capacity():
    from .config import settings
    from .storage import Preference
    from .provider_cache import budget_transaction
    with budget_transaction() as db:
        row = db.get(Preference, CAPACITY_KEY)
        value = row.value.get("max_bars") if row else settings.native_history_default_bars
    if type(value) is not int or value < MIN_CAPACITY:
        value = settings.native_history_default_bars
    return min(value, settings.native_history_max_bars)


def save_capacity(value):
    from .config import settings
    from .storage import Preference, transaction
    from sqlalchemy import text
    if type(value) is not int or not MIN_CAPACITY <= value <= settings.native_history_max_bars:
        raise ValueError(f"容量须为 {MIN_CAPACITY:,} 至 {settings.native_history_max_bars:,} 根之间的整数")
    with transaction() as db:
        if db.get_bind().dialect.name == "postgresql":
            db.execute(text("SELECT pg_advisory_xact_lock(8675321)"))
        row = db.get(Preference, CAPACITY_KEY)
        if row:
            row.value = {"max_bars": value}
        else:
            db.add(Preference(key=CAPACITY_KEY, value={"max_bars": value}))
    return capabilities()


def capabilities():
    import hashlib
    import json

    from .config import settings
    limit = capacity()
    values = {
        "max_bars": limit, "workspace_bars": min(settings.native_history_workspace_bars, limit * 4),
        "min_bars": MIN_CAPACITY, "hard_max_bars": settings.native_history_max_bars,
        "default_bars": min(settings.native_history_default_bars, settings.native_history_max_bars),
        "response_bytes": settings.native_history_response_bytes,
        "task_seconds": settings.native_history_task_seconds,
        "max_pages": settings.native_history_task_pages, "max_inflight": 8,
        "mode": "continuous", "protocol": 1,
    }
    return {**values, "version": hashlib.sha256(json.dumps(values, sort_keys=True).encode()).hexdigest()[:16]}


class CapacityExceeded(ValueError):
    code = "NATIVE_HISTORY_CAPACITY_EXCEEDED"


def optional_bars(context, demand, prefix, *, hot, first, enabled, python=False,
                  cold_extra=400, first_extra=2000, history_extra=2000, history_limit=None):
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
    limit = capacity() if history_limit is None else history_limit
    return min(amount, max(0, budget - demand), max(0, limit - demand - prefix))
