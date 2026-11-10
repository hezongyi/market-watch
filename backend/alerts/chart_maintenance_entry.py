"""Canonical maintenance entry for on-demand platform history.

The HTTP route is an Adapter: it validates the request and maps errors to
status codes. This module owns the provider-boundary check and chart plan
update so future callers cannot accidentally fork the maintenance workflow.
"""

import httpx

from .market_data import resolve
from .storage import ChartHistoryPlan, instant, now_ms, transaction


class MaintenanceUnavailable(RuntimeError):
    """The provider boundary could not be confirmed without changing state."""


def configure(instrument, start_date):
    from .chart_history_plan import plan_status, record_boundary
    from .managed_dataset import date_start, join

    with transaction() as db:
        inst = resolve(db, instrument)
        try:
            start = date_start(inst, start_date)
        except ValueError:
            raise
        meta = {"id": inst.id, "source": inst.source, "symbol": inst.symbol, "basis": inst.basis}

    # Do not hold a database connection during supplier I/O. A failed probe
    # leaves the existing maintenance plan untouched.
    try:
        from . import provider_chart

        earliest = provider_chart.earliest_m1(meta)
    except (httpx.HTTPError, TimeoutError, ValueError) as error:
        raise MaintenanceUnavailable from error
    if start < earliest:
        raise ValueError(
            f"历史起点不可达：该品种最早可用M1为 {instant(earliest).isoformat()}；请明确选择可达起点，原维护范围保持不变"
        )

    with transaction() as db:
        inst = resolve(db, instrument)
        existing = db.get(ChartHistoryPlan, inst.id)
        if existing and existing.target_start < earliest:
            record_boundary(db, inst, existing.target_start, earliest, now_ms())
        plan = join(db, inst, start, now_ms())
        record_boundary(db, inst, plan.target_start, earliest, now_ms())
        return {**plan_status(db, plan, now_ms()), "calendar": inst.calendar}
