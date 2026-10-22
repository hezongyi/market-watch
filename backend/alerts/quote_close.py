"""Closing-price evidence for daily buckets derived from stored M1 observations."""

from decimal import Decimal, InvalidOperation


def confirmed_daily_close(daily, minute):
    """Allow interior gaps only when the bucket's last M1 confirms its close.

    Time closure and confirmation of the observations present in a daily bucket
    do not establish that its ending observations exist. Keep this check on the
    read path so old immutable artifacts need not be rewritten.
    """
    end = daily.get("end")
    if (type(end) is not int or daily.get("source_confirmed") is not True
            or daily.get("time_closed") is not True
            or minute.get("end") != end or minute.get("start") != end - 60000
            or minute.get("source_confirmed") is not True
            or minute.get("time_closed") is not True or minute.get("complete") is not True):
        return None
    try:
        value, closing = Decimal(str(daily.get("close"))), Decimal(str(minute.get("close")))
    except (InvalidOperation, TypeError, ValueError):
        return None
    return value if value.is_finite() and closing.is_finite() and value > 0 and value == closing else None
