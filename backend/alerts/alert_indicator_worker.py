"""Advance bounded fixed-indicator pages required by active composite alerts."""

import logging

from sqlalchemy import select

from .fixed_indicators import indicator_tick
from .runtime_health import assert_current, progress
from .storage import ChartAlert, FixedIndicatorRun, transaction

log = logging.getLogger(__name__)


class IndicatorDependencyError(RuntimeError):
    """A persisted dependency failure remains visible throughout retry backoff."""

    def __init__(self, error_type):
        self.error_type = error_type
        super().__init__(error_type)


def tick(*, failures=None):
    """Advance at most one persisted indicator run referenced by an active rule."""
    failures = {} if failures is None else failures
    with transaction() as db:
        assert_current(db)
        alerts = db.scalars(select(ChartAlert.runtime).where(
            ChartAlert.status == "active").order_by(ChartAlert.id))
        run_ids = set()
        for runtime in alerts:
            dependencies = [*runtime.get("indicators", []),
                            *runtime.get("offset_indicators", [])]
            run_ids.update(item["run_id"] for item in dependencies
                           if item.get("run_id") and item.get("status") != "complete")
        run_ids = sorted(run_ids)
    for stale in set(failures) - set(run_ids):
        del failures[stale]
    worked = False
    for run_id in run_ids:
        try:
            worked = indicator_tick(run_id, alert_priority=True, raise_errors=True)
        except Exception as error:
            # A lost lease forbids writing its run.error. Keep this failed
            # dependency degraded until actual completion or demand removal.
            failures[run_id] = type(error).__name__
            raise
        if worked:
            break
    if run_ids:
        with transaction() as db:
            assert_current(db)
            for ident, status, error in db.execute(select(
                    FixedIndicatorRun.id, FixedIndicatorRun.status, FixedIndicatorRun.error)
                    .where(FixedIndicatorRun.id.in_(run_ids)).order_by(FixedIndicatorRun.id)):
                if status == "complete":
                    failures.pop(ident, None)
                elif error:
                    failures[ident] = error
            if failures:
                raise IndicatorDependencyError(next(iter(failures.values())))
    return worked


def run(stop):
    failures = {}
    while not stop.is_set():
        worked = False
        try:
            worked = tick(failures=failures)
            progress(state="running" if worked else "idle")
        except Exception as error:
            log.warning("alert_indicator_tick_failed type=%s", type(error).__name__)
            progress(state="degraded", error=(error.error_type
                if isinstance(error, IndicatorDependencyError) else error))
        stop.wait(.01 if worked else .1)
