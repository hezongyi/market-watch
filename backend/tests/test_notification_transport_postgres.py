"""Concurrent first-save and cross-session transport settings on isolated PG."""
from concurrent.futures import ThreadPoolExecutor
import pytest
from fastapi import HTTPException
from sqlalchemy.orm import sessionmaker
from alerts import storage
from alerts.notification_transport import TransportInput, save_transport, transport_config
from test_chart_alert_postgres import postgres_alerts


def test_concurrent_first_save_does_not_overwrite_and_other_process_reads_new_config(postgres_alerts, monkeypatch):
    storage.bootstrap(postgres_alerts)
    factory = sessionmaker(postgres_alerts, expire_on_commit=False)
    monkeypatch.setattr(storage, "Session", factory)
    def save(index):
        try:
            return save_transport(TransportInput(url="https://ntfy.example", topic=f"topic-{index}", revision=0))["revision"]
        except HTTPException as error:
            return error.status_code
    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(save, range(2)))
    assert sorted(results) == [1, 409]
    with factory() as db:
        assert transport_config(db)["revision"] == 1
        assert transport_config(db)["topic"] in ("topic-0", "topic-1")


def test_receipt_during_publish_preserves_acceptance_and_does_not_deadlock(postgres_alerts, monkeypatch):
    import httpx
    from alerts import api, notify
    storage.bootstrap(postgres_alerts)
    factory = sessionmaker(postgres_alerts, expire_on_commit=False)
    monkeypatch.setattr(storage, "Session", factory)
    save_transport(TransportInput(url="https://ntfy.example", topic="test-only"))
    queued = api.send_notification_test()
    def accepted(_request):
        api.confirm_notification_test_received(queued["test_id"])
        return httpx.Response(200, json={"id":"fixture"})
    assert notify.deliver_once(httpx.Client(transport=httpx.MockTransport(accepted)))
    assert api.notification_test_result(queued["test_id"])["status"] == "acknowledged"
