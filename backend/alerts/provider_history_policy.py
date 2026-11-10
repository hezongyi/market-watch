"""Optional native history budgets; mandatory demand never depends on these."""

CAPACITY_KEY = "advanced:history-capacity:v1"
MIN_CAPACITY = 20000


def capacity():
    from .config import settings
    from .provider_cache import budget_transaction
    from .storage import Preference
    with budget_transaction() as db:
        row = db.get(Preference, CAPACITY_KEY)
        value = row.value.get("max_bars") if row else settings.native_history_default_bars
    if type(value) is not int or value < MIN_CAPACITY:
        value = settings.native_history_default_bars
    return min(value, settings.native_history_max_bars)


def save_capacity(value):
    from sqlalchemy import text

    from .config import settings
    from .storage import Preference, transaction
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
        "mode": "continuous", "protocol": 1, "result_polling": True, "result_waiting": True,
        "startup_preparation": True,
    }
    return {**values, "version": hashlib.sha256(json.dumps(values, sort_keys=True).encode()).hexdigest()[:16]}


class CapacityExceeded(ValueError):
    code = "NATIVE_HISTORY_CAPACITY_EXCEEDED"


def optional_bars(context, demand, prefix, *, source, hot, first, enabled, python=False,
                  history_limit=None, db=None):
    if not enabled or python:
        return 0
    target = source_prefetch(source, db=db)["initial_bars"]
    # Keep pane fairness; viewport size does not constrain upstream acquisition.
    if context.chart_count > 1:
        target = min(target, demand + prefix + 1000)
    if context.chart_count >= 4 and context.focused is False:
        return 0
    limit = capacity() if history_limit is None else history_limit
    return max(0, min(target, limit) - demand - prefix)


PREFETCH_KEY = "advanced:provider-prefetch:v1"
MAX_PREFETCH = 20000
PREFETCH_DEFAULTS = {
    "oanda": {"initial_bars": 2000, "reserve_bars": 4000},
    "binance": {"initial_bars": 1000, "reserve_bars": 4000},
    "dukascopy": {"initial_bars": 2000, "reserve_bars": 4000},
    "yahoo": {"initial_bars": 2000, "reserve_bars": 4000},
    "akshare": {"initial_bars": 1000, "reserve_bars": 4000},
    "fxcm": {"initial_bars": 300, "reserve_bars": 2000},
}


def _prefetch(db):
    from .storage import Preference
    row = db.get(Preference, PREFETCH_KEY)
    stored = row.value.get("sources", {}) if row else {}
    return {source: {**defaults, **stored.get(source, {})}
            for source, defaults in PREFETCH_DEFAULTS.items()}


def source_prefetch(source, db=None):
    from .provider_cache import budget_transaction
    if source not in PREFETCH_DEFAULTS:
        raise ValueError("未知平台源")
    if db is not None:
        return _prefetch(db)[source]
    with budget_transaction() as owned:
        values = _prefetch(owned)[source]
    limit = min(MAX_PREFETCH, capacity())
    return {key: min(value, limit) for key, value in values.items()}


def prefetch_capabilities():
    from .provider_cache import budget_transaction
    from .provider_capabilities import page_capacity
    with budget_transaction() as db:
        values = _prefetch(db)
    limit = min(MAX_PREFETCH, capacity())
    return {
        "version": 1, "sources": values,
        "effective": {source: {key: min(value, limit) for key, value in item.items()}
                      for source, item in values.items()},
        "defaults": {source: dict(item) for source, item in PREFETCH_DEFAULTS.items()},
        "max_bars": limit,
        "page_bars": {source: page_capacity(source) for source in PREFETCH_DEFAULTS},
    }


def save_prefetch(values):
    from sqlalchemy import text

    from .provider_service import reconcile_prefetch
    from .storage import Preference, transaction
    limit = min(MAX_PREFETCH, capacity())
    if not isinstance(values, dict) or values.keys() != PREFETCH_DEFAULTS.keys():
        raise ValueError("须保存完整的六源预取设置")
    for source, item in values.items():
        if not isinstance(item, dict) or item.keys() != {"initial_bars", "reserve_bars"}:
            raise ValueError(f"{source} 预取字段无效")
        if any(type(value) is not int or not 0 <= value <= limit for value in item.values()):
            raise ValueError(f"预取数量须为 0 至 {limit:,} 的整数")
        if item["reserve_bars"] and item["reserve_bars"] < item["initial_bars"]:
            raise ValueError("后台储备总量须不少于首屏采集目标，或设为 0 关闭")
    with transaction() as db:
        if db.get_bind().dialect.name == "postgresql":
            db.execute(text("SELECT pg_advisory_xact_lock(8675322)"))
        row = db.get(Preference, PREFETCH_KEY)
        content = {"version": 1, "sources": values}
        if row:
            row.value = content
        else:
            db.add(Preference(key=PREFETCH_KEY, value=content))
        # Retarget with fresh task identities in the same commit: a worker
        # already outside its transaction cannot resurrect the previous goal.
        reconcile_prefetch(db, values)
    return prefetch_capabilities()
