"""Classify fixed-version observations using finite source evidence, not phase."""

from .calendar_profile import closures_from
from .domain import calendar_from, scheduled_open
from .storage import instant


def add_interval(intervals, left, right):
    if intervals and intervals[-1][1] == left:
        intervals[-1][1] = right
    else:
        intervals.append([left, right])


def classify(version, rows, missing):
    profile = version.manifest.get("calendar_profile", {})
    calendar = calendar_from(version.manifest.get("aggregation_calendar", "ny17"), profile, explicit=True)
    closures = closures_from(profile)
    observed, conflicts, unknown, closed = [], [], [], []
    evidence = []
    session = calendar.session
    if session:
        evidence.append({"source": session.evidence_url, "kind": "weekly_source_session",
                         "reviewed_start": int(session.reviewed_start.timestamp() * 1000),
                         "reviewed_end": int(session.reviewed_end.timestamp() * 1000),
                         "applicability": session.applicability})
    for closure in closures:
        evidence.append({"source": closure.source, "kind": closure.kind, "reason": closure.reason,
                         "start": int(closure.start.timestamp() * 1000),
                         "end": int(closure.end.timestamp() * 1000)})
    def is_closed(at):
        return not scheduled_open(instant(at), calendar, closures=closures)

    for row in rows:
        at = row["timestamp"]
        add_interval(observed, at, at + 60000)
        if is_closed(at):
            add_interval(conflicts, at, at + 60000)
    # Without applicable evidence, a successful query gap remains unknown.
    if not session and not closures:
        unknown = [list(span) for span in missing]
    else:
        for left, right in missing:
            for at in range(left, right, 60000):
                add_interval(closed if is_closed(at) else unknown, at, at + 60000)
    def minutes(intervals):
        return sum((right - left) // 60000 for left, right in intervals)
    return {"observed_intervals": observed, "observed_minutes": len(rows),
            "unknown_intervals": unknown, "unknown_minutes": minutes(unknown),
            "confirmed_closed_intervals": closed, "confirmed_closed_minutes": minutes(closed),
            "conflict_intervals": conflicts, "conflict_minutes": minutes(conflicts),
            "unobserved_minutes": minutes(missing), "session_evidence": evidence,
            "classification": "fixed-version source evidence; observations preserved despite conflicts"}
