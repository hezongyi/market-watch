"""A source may commit between a monitor's clock capture and its locked read."""

from alerts import chart_alert_worker
from alerts.storage import ChartAlert, SignalRow
from sqlalchemy import func, select
from test_composite_alerts import armed, evaluate, forming


def test_new_cross_committed_after_clock_capture_is_not_lost(database, monkeypatch):
    ident, _, revision, seam, stamp = armed(database, monkeypatch, mode="intrabar")
    forming(database, revision, seam + 600000, stamp, price="1.11")
    with database.begin() as db:
        assert evaluate(db, ident, now=stamp) == []
        assert db.get(ChartAlert, ident).health == "ready"
    captured = []

    def clock():
        if not captured:
            # Capture first, then let the independent source commit before the
            # evaluator's transaction reads LiveState (READ COMMITTED).
            captured.append(stamp + 1000)
            forming(database, revision, seam + 600000, stamp + 1001, price="1.119")
            return captured[0]
        return stamp + 1002

    monkeypatch.setattr(chart_alert_worker, "now_ms", clock)
    chart_alert_worker.step()
    with database() as db:
        row = db.get(ChartAlert, ident)
        assert row.count == 1, (row.health, row.health_reason, row.state)
        assert db.scalar(select(func.count()).select_from(SignalRow)) == 1
