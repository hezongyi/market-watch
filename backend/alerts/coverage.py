"""Query coverage is distinct from observed candle density and market availability."""


def covers_interval(ranges, start: int, end: int) -> bool:
    """Whether successful half-open query intervals cover every instant requested.

    This does not prove that a provider recorded every market observation.
    Invalid and empty intervals cannot contribute coverage.
    """
    if end <= start:
        return False
    cursor = start
    for left, right in sorted((r["start"], r["end"]) for r in ranges if r["end"] > r["start"]):
        if right <= cursor:
            continue
        if left > cursor:
            return False
        cursor = right
        if cursor >= end:
            return True
    return False
