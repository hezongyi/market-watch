from decimal import Decimal as D

import httpx
from alerts import notify
from alerts.chart_alert_domain import Observation
from alerts.chart_alert_message import signal_message
from alerts.chart_alert_service import AlertConfig, consume, create
from alerts.storage import ChartAlert, Notification, Outbox, SignalRow
from sqlalchemy import select


def test_indicator_message_preserves_units_and_delivery_retry_does_not_increment_count(database, monkeypatch):
    config = AlertConfig.model_validate({
        "name": "RSI 上穿", "instrument": "BTCUSDT", "source": "binance", "timeframe": "M1",
        "max_triggers": 3, "notify_ntfy": True, "message": "{symbol} {value} / {price}",
        "condition": {"relation": "cross_up", "left": {"kind": "indicator", "indicator": {
            "name": "RSI", "params": {"period": 2},
        }}, "right": {"kind": "constant", "value": 30}},
    })
    with database.begin() as db:
        ident = create(db, "notification-units", config, at=0).id
        consume(db, ident, Observation("before", 0, 0, D(20), D(30), D(100)), detected_at=0)
        record = consume(db, ident, Observation("after", 1, 1000, D(35), D(30), D(105)), detected_at=1001)
        message = signal_message(record)
        assert "指标值 35 / 比较值 30" in message
        assert "市场价格 105" in message
        assert "BTCUSDT 35 / 105" in message
        assert "binance · M1" in message
    monkeypatch.setattr(notify.settings, "delivery_enabled", True)
    monkeypatch.setattr(notify.settings, "ntfy_topic", "isolated-mock-only")
    monkeypatch.setattr(notify.settings, "ntfy_url", "http://isolated-mock.invalid")
    monkeypatch.setattr(notify, "now_ms", lambda: 5000)
    attempted = []

    def transport(request):
        attempted.append(request)
        # Service failure followed by acceptance, entirely within local MockTransport.
        return httpx.Response(503 if len(attempted) == 1 else 200, json={"id": "mock-accepted"})

    with httpx.Client(transport=httpx.MockTransport(transport)) as client:
        notify.deliver_once(client)
        with database.begin() as db:
            task = db.scalar(select(Outbox))
            task.next_at = 5000
        notify.deliver_once(client)
    with database() as db:
        assert db.get(ChartAlert, ident).count == 1
        assert len(list(db.scalars(select(SignalRow)))) == 1
        assert db.scalar(select(Notification.status)) == "server_accepted"
        assert db.scalar(select(Outbox.attempts)) == 2
        assert len(attempted) == 2
