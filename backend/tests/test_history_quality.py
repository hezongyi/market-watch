"""Only reviewed source rules classify closures; observations always survive."""

from types import SimpleNamespace

from alerts.history_quality import classify
from alerts.storage import ms
from test_market_contracts import minute
from test_source_calendar import dt, profile


def test_ny17_phase_alone_leaves_weekend_and_maintenance_gaps_unknown():
    left = ms(dt("2026-07-11T21:00:00+00:00"))
    version = SimpleNamespace(manifest={"aggregation_calendar": "ny17", "calendar_profile": {}})
    report = classify(version, [], [[left, left + 3600000]])
    assert report["unknown_minutes"] == 60 and report["confirmed_closed_minutes"] == 0
    assert report["session_evidence"] == []


def test_reviewed_source_interior_conflicts_and_unknown_boundary_are_distinct():
    left = ms(dt("2026-07-06T21:00:00+00:00"))
    version = SimpleNamespace(manifest={"aggregation_calendar": "ny17", "calendar_profile": profile()})
    report = classify(version, [minute(left).model_dump()], [
        [left - 60000, left], [left + 60000, left + 64 * 60000],
        [left + 64 * 60000, left + 65 * 60000]])
    assert report["observed_minutes"] == report["conflict_minutes"] == 1
    assert report["confirmed_closed_minutes"] == 63 and report["unknown_minutes"] == 2
    assert report["unobserved_minutes"] == 65
    assert report["observed_intervals"] == [[left, left + 60000]]
    assert report["session_evidence"][0]["source"].startswith("https://")


def test_reviewed_source_classification_uses_dst_and_finite_applicability():
    version = SimpleNamespace(manifest={"aggregation_calendar": "ny17", "calendar_profile": profile()})
    for value in ("2026-03-06T22:01:00+00:00", "2026-03-09T21:01:00+00:00"):
        left = ms(dt(value))
        assert classify(version, [], [[left, left + 60000]])["confirmed_closed_minutes"] == 1
    left = ms(dt("2027-03-09T22:01:00+00:00"))
    assert classify(version, [], [[left, left + 60000]])["unknown_minutes"] == 1
