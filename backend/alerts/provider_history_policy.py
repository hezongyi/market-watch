"""Optional native history budgets; mandatory demand never depends on these."""

CAPACITY = 20000


class CapacityExceeded(ValueError):
    code = "NATIVE_HISTORY_CAPACITY_EXCEEDED"


def optional_bars(context, demand, prefix, *, hot, first, enabled, python=False,
                  cold_extra=400, first_extra=2000, history_extra=2000):
    if not enabled or python:
        return 0
    budget = 4000 if context.chart_count == 1 else 2000
    amount = (first_extra if first and not context.historical_navigation else history_extra) if hot else cold_extra
    if context.chart_count > 1:
        amount = min(amount, 1000)
    if context.chart_count >= 4 and context.focused is False:
        amount = 0
    return min(amount, max(0, budget - demand), max(0, CAPACITY - demand - prefix))
