"""Conservative D1 freshness from actual source boundaries and reviewed sessions.

Unknown calendars remain dated references, never effective current rankings.
"""

from datetime import UTC, datetime

from .storage import instant, ms


def expected_end(meta, cutoff):
    source, symbol = meta.get("source", ""), meta.get("symbol", "")
    sessions = meta.get("sparkline_sessions", {})
    if sessions and meta.get("session_evidence_at", 0) >= cutoff:
        ended = [
            value["end"]
            for value in sessions.values()
            if isinstance(value, dict) and type(value.get("end")) is int and value["end"] <= cutoff
        ]
        if ended:
            return max(ended), "来源交易时段"
    calendar = meta.get("calendar")
    if calendar in ("ny17", "utc0"):
        from .domain import Calendar, session_bounds

        right = ms(session_bounds(instant(cutoff), Calendar(calendar))[0])

        def previous(value):
            return ms(session_bounds(instant(value - 1), Calendar(calendar))[0])
    elif calendar == "dukascopy_native_utc":
        right = int(
            datetime.fromtimestamp(cutoff / 1000, UTC)
            .replace(hour=0, minute=0, second=0, microsecond=0)
            .timestamp()
            * 1000
        )

        def previous(value):
            return value - 86400000
    elif source == "oanda":
        from .native_series import parameters, session_start

        values = parameters(meta)
        right = session_start(cutoff, values)

        def previous(value):
            return session_start(value - 1, values)
    else:
        return None, "新鲜度未核实"
    from .live_session import effective_profile, unclosed_milliseconds
    from .market_calendar import observation_identity, session_status

    identity = observation_identity(source, symbol, meta)
    profile = effective_profile(identity, meta.get("calendar_profile"))
    # A week of source-bound intervals handles ordinary closures. Longer or
    # unverifiable calendars are deliberately not guessed from weekdays.
    for _ in range(8):
        left = previous(right)
        opened = unclosed_milliseconds(identity, profile, left, right)
        if opened is None:
            evidence = [
                session_status(source, symbol, stamp, metadata=meta)
                for stamp in range(left, right, 30 * 60000)
            ]
            if not evidence or not all(item.get("calendar_verified") for item in evidence):
                return None, "新鲜度未核实"
            opened = any(item["market_session"] == "scheduled_open" for item in evidence)
        if opened:
            return right, "已核实交易日历"
        right = left
    return None, "新鲜度未核实"


def assess(meta, rows, cutoff, kind):
    if len(rows) < 2:
        return (
            "insufficient_history",
            "缺少两根确认日线",
            "固定历史" if kind == "history" else "新鲜度未核实",
        )
    if kind == "history":
        return "not_updated", "固定历史，仅作日期参考", "固定历史"
    expected, evidence = expected_end(meta, cutoff)
    if expected is None:
        return "not_updated", "无法核实本期应完成的交易日，仅作日期参考", evidence
    if rows[-1]["end"] < expected:
        return "not_updated", "本期日线尚未更新，仅保留历史参考", evidence
    return "ok", "", evidence
