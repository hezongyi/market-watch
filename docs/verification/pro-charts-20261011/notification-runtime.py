"""Persist controlled alert observations in the task-only PG; never deliver.

Run inside this task's API container with ids created by the browser acceptance.
This validates the evaluator's commit/message/API path, not supplier triggers.
"""
import json
import sys
import uuid
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.engine import make_url
from alerts.config import settings
from alerts.storage import ChartAlert, Notification, Outbox, SignalRow, transaction, now_ms
from alerts.chart_alert_domain import Observation
from alerts.chart_alert_message import signal_message
from alerts.chart_alert_service import AlertConfig, create, consume, current_version

url = make_url(settings.database_url)
assert url.host == "pg" and url.database == "pro_charts"
assert settings.database_application_name == "mw-pro-charts-20261011"
assert not settings.delivery_enabled
# Match fixture-runtime.py's process-local synthetic identity; this exec does
# not inherit the API process's Settings overrides.
settings.oanda_account_id = "pro-charts-fixture"
settings.oanda_token = "fixture-no-provider-access"

results = []
for ident in sys.argv[1:]:
    with transaction() as db:
        source_alert = db.get(ChartAlert, ident)
        assert source_alert is not None
        source_version = current_version(db, source_alert)
        alert = create(db, "acceptance-notification-" + uuid.uuid4().hex,
                       AlertConfig.model_validate(source_version.config), at=now_ms())
        version = current_version(db, alert)
        config = version.config
        assert not config["notify_ntfy"]
        assert config["condition"]["right"]["kind"] == "constant"
        threshold = Decimal(config["condition"]["right"]["value"])
        at = alert.effective_at
        consume(db, alert.id, Observation("acceptance-baseline", 0, at,
                threshold - 1, threshold, threshold - 1), detected_at=at, baseline=True)
        event = consume(db, alert.id, Observation("acceptance-cross", 1, at + 1000,
                threshold + 1, threshold, threshold + 1), detected_at=at + 1001)
        assert event is not None
        note = db.scalar(select(Notification).where(Notification.signal_id == event.id))
        assert note.status == "web_only"
        assert db.scalar(select(Outbox.id).where(Outbox.notification_id == note.id)) is None
        assert event.threshold == threshold
        message = signal_message(event)
        from alerts.market_names import display_code
        code = display_code(version.market_identity["symbol"], config["source"])
        assert message.startswith(code + " · ")
        assert f"比较值 {threshold}" in message
        results.append({"source_alert_id": ident, "alert_id": alert.id, "signal_id": event.id,
                        "notification_status": note.status, "outbox": False,
                        "threshold": str(event.threshold), "message": message})
with transaction() as db:
    for result in results:
        event = db.get(SignalRow, result["signal_id"])
        assert event.evidence["threshold"] == result["threshold"]
        assert signal_message(event) == result["message"]
print(json.dumps({"passed": True, "supply": "controlled observations", "cases": results}, ensure_ascii=False))
