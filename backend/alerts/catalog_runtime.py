"""Low-frequency catalog refresh; never downloads candles or starts demand."""

import logging

from . import runtime_health
from .catalog_sync import refresh, statuses
from .config import settings
from .history_catalog import account_scope
from .storage import now_ms, transaction

log = logging.getLogger(__name__)


def run(stop):
    # Give provider workers their normal startup window first.
    if stop.wait(60):
        return
    while not stop.is_set():
        jobs = [("dukascopy", "all"), ("binance", "all")]
        if settings.oanda_token and settings.oanda_account_id:
            jobs.append(("oanda", "all"))
        if settings.fxcm_enabled:
            jobs.append(("fxcm", "all"))
        if settings.yahoo_enabled:
            jobs.append(("yahoo", "all"))
        if settings.akshare_enabled:
            jobs.extend(("akshare", market) for market in ("a", "hk", "futures"))
        for source, partition in jobs:
            scope = account_scope() if source == "oanda" else "public"
            if source == "fxcm":
                from .fxcm_history import account_scope as fxcm_scope
                scope = fxcm_scope()
            with transaction() as db:
                previous = [row for row in statuses(db, source) if row["scope"] == scope
                    and (row["partition"] == partition or source == "yahoo")]
            runtime_health.progress()
            if previous and all(now_ms() - row.get("last_attempt", 0) < 86400000 for row in previous):
                continue
            try:
                refresh(source, market=partition)
            except Exception:
                # Only the source name is logged; provider exceptions may contain credentials.
                log.warning("目录刷新失败：%s/%s；保留最近成功快照", source, partition)
            if stop.wait(1):
                return
        for _ in range(60):
            runtime_health.progress()
            if stop.wait(60):
                return
