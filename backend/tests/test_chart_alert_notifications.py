from decimal import Decimal as D
from types import SimpleNamespace
import os

import httpx
import pytest
from alerts import notify
from alerts.chart_alert_domain import Observation
from alerts.chart_alert_message import signal_message, signal_title
from alerts.chart_alert_service import AlertConfig, consume, create
from alerts.storage import ChartAlert, ChartAlertVersion, Notification, Outbox, SignalRow
from sqlalchemy import select
from test_provider_postgres import provider_pg


@pytest.mark.parametrize("kind,source,instrument,symbol,shown", [
    ("provider", "yahoo", "YAHOO:JPY_X", "JPY=X", "USDJPY"),
    ("provider", "yahoo", "YAHOO:AAPL", "AAPL", "AAPL"),
    ("managed", "oanda", "managed-eurusd", "EUR_USD", "EURUSD"),
    ("composite", "composite", "a" * 64, "EURUSD", "EURUSD"),
])
def test_notification_uses_saved_readable_symbol_and_preserves_decimal_threshold(
        kind, source, instrument, symbol, shown):
    threshold = "1.128313520286396123"
    signal = SimpleNamespace(
        id="notification-identity", instrument_id=instrument, occurred_at=1000, reason="原有自定义名称",
        price=D("1.13"), threshold=D(threshold),
        evidence={"chart_alert": True, "market_identity": {
            "series_kind": kind, "source": source, "symbol": symbol},
            "config": {"timeframe": "M1", "message": "{symbol} {threshold}",
                       "condition": {"relation": "above", "left": {"kind": "price"},
                                     "right": {"kind": "constant", "value": threshold}}},
            "detected_at": 1001, "left": "1.13", "unit": "price", "late": False})
    message = signal_message(signal)
    assert message.startswith(f"{shown} {threshold}\n{shown} · {source} · M1\n")
    assert f"比较值 {threshold}" in message
    assert signal_title(signal) == f"{shown} · 原有自定义名称"
    assert signal.threshold == D(threshold)


@pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated Ubuntu PostgreSQL")
def test_committed_pg_event_message_preserves_manual_precision(provider_pg, monkeypatch):
    from alerts.storage import Instrument, Preference

    factory, _ = provider_pg
    threshold = "1.123456789012345678"
    config = AlertConfig.model_validate({
        "name": "manual decimal", "instrument": "notification-managed", "source": "oanda", "timeframe": "M1",
        "condition": {"relation": "cross_up", "left": {"kind": "price"},
                      "right": {"kind": "constant", "value": threshold}}})
    with factory.begin() as db:
        db.add(Instrument(id=config.instrument, symbol="EUR_USD", label="acceptance", source="oanda",
                          basis="bid", calendar="ny17", precision=5, enabled=True))
        db.add(Preference(key="auth.admin", value={}))
    with factory.begin() as db:
        alert = create(db, "notification-exact", config, at=0)
        ident = alert.id
        consume(db, ident, Observation("baseline", 0, 0, D(1), D(threshold), D(1)), baseline=True)
        event = consume(db, ident, Observation("cross", 1, 1000, D(2), D(threshold), D(2)), detected_at=1001)
        event_id = event.id
    with factory() as db:
        event = db.get(SignalRow, event_id)
        assert f"比较值 {threshold}" in signal_message(event)
        assert event.evidence["threshold"] == threshold
        assert event.evidence["price"] == "2"
        version = db.scalar(select(ChartAlertVersion).where(ChartAlertVersion.alert_id == ident))
        assert version.config["condition"]["right"]["value"] == threshold
    from alerts import api as api_module
    from fastapi.testclient import TestClient
    from test_chart_alert_api import login

    with TestClient(api_module.app) as client:
        login(client, monkeypatch)
        saved = client.get("/api/chart-alerts/events", params={"alert_id": ident}).json()[0]
        assert saved["threshold"] == threshold
        assert saved["price"] == "2"
        assert f"比较值 {threshold}" in saved["message"]


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
