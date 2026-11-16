"""Dated Yahoo regular-session evidence for mobile display only.

No holiday guesses, collection demand, price writes or independent poll loop.
"""
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo


def source_sessions(meta, payload):
    zone = ZoneInfo(meta["timezone"])
    output = {}

    def collect(value):
        if isinstance(value, (list, tuple)):
            for part in value:
                collect(part)
        elif isinstance(value, dict):
            start, end = value.get("start"), value.get("end")
            if type(start) is int and type(end) is int and 60 <= end - start <= 86400:
                left = datetime.fromtimestamp(start, zone)
                right = datetime.fromtimestamp(end - 1, zone)
                if left.date() == right.date():
                    output[left.date().isoformat()] = {"start": start * 1000, "end": end * 1000}

    collect((payload.get("currentTradingPeriod") or {}).get("regular"))
    periods = payload.get("tradingPeriods")
    collect(periods.get("regular") if isinstance(periods, dict) else periods)
    return output


def refresh(symbol, meta, stamp):
    """Explicit prepare may fill today's missing evidence, at most every 15min.

    Reuse the authenticated Yahoo transport and its request/deadline budgets;
    persist only session timestamps under the exact maintained catalog identity.
    """
    from . import storage
    from .sparklines import stock_clock
    from .storage import MarketCatalog

    local = stock_clock(meta, stamp)
    if local is None:
        return
    date = local.date().isoformat()
    with storage.Session() as db:
        entry = db.get(MarketCatalog, symbol)
        if entry is None:
            return
        previous = entry.metadata_json
        if date in previous.get("sparkline_sessions", {}) or stamp < previous.get("sparkline_calendar_retry_at", 0):
            return
    from .provider_yahoo import regular_sessions
    try:
        sessions = regular_sessions(meta, stamp)
    except Exception:
        # Unknown is deliberate; a metadata failure does not erase valid prices.
        sessions = {}
    with storage.Session.begin() as db:
        entry = db.get(MarketCatalog, symbol)
        if entry is None or entry.source != "yahoo":
            return
        value = dict(entry.metadata_json)
        retained = {**value.get("sparkline_sessions", {}), **sessions}
        floor = (local.date() - timedelta(days=14)).isoformat()
        value["sparkline_sessions"] = {key: item for key, item in sorted(retained.items()) if key >= floor}
        value["sparkline_calendar_retry_at"] = stamp + 15 * 60000
        entry.metadata_json = value
