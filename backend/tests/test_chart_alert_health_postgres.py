"""Health summaries must execute and count execution states on PostgreSQL."""

from alerts.chart_alert_health import summary
from alerts.chart_alert_service import create
from alerts.storage import Instrument, bootstrap
from sqlalchemy.orm import sessionmaker
from test_chart_alert_postgres import postgres_alerts as postgres_alerts
from test_chart_alert_service import config


def test_execution_summary_groups_json_states_on_postgres(postgres_alerts, monkeypatch):
    from alerts.storage import settings

    monkeypatch.setattr(settings, "fx_source", "dukascopy")
    bootstrap(postgres_alerts)
    factory = sessionmaker(postgres_alerts)
    with factory.begin() as db:
        db.get(Instrument, "EURUSD").enabled = True
    with factory() as db:
        assert summary(db, at=1000)["execution"] == {}

    cases = [
        ("active", None, {"execution_state": "monitoring"}),
        ("active", 2000, {"execution_state": "monitoring"}),
        ("active", 500, {"execution_state": "closed"}),
        ("expired", 500, {"execution_state": "settling", "settlement_pending": True}),
        ("paused", None, {"execution_state": "recovering", "incident": {"id": "incident"}}),
        ("archived", None, {"execution_state": "closed", "settlement_pending": True}),
        ("paused", None, {"execution_state": "closed"}),
        ("active", None, {}),
    ]
    with factory.begin() as db:
        for index, (status, expires_at, runtime) in enumerate(cases):
            row = create(db, f"health-{index}", config(), at=0)
            row.status, row.expires_at, row.runtime = status, expires_at, runtime

    with factory() as db:
        assert summary(db, at=1000)["execution"] == {
            "monitoring": 2, "settling": 1, "recovering": 1,
        }
