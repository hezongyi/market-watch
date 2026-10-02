"""Optional native history budgets; mandatory demand never depends on these."""

CAPACITY = 20000


class CapacityExceeded(ValueError):
    code = "NATIVE_HISTORY_CAPACITY_EXCEEDED"


def optional_bars(context, demand, prefix, *, hot, first, enabled, python=False):
    if not enabled or python:
        return 0
    budget = 4000 if context.chart_count == 1 else 2000
    amount = (3000 if first and not context.historical_navigation else 2000) if hot else 600
    if context.chart_count > 1:
        amount = min(amount, 1000)
    if context.chart_count >= 4 and context.focused is False:
        amount = 0
    return min(amount, max(0, budget - demand), max(0, CAPACITY - demand - prefix))
