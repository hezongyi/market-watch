"""Connection diagnostics distinguish local failures without leaking exceptions."""

import logging
import threading
from types import SimpleNamespace

import httpx
import pytest
from alerts import oanda_worker as worker
from alerts.runtime_health import reporting
from sqlalchemy.exc import OperationalError


@pytest.fixture
def collecting(monkeypatch):
    identities = {"EUR_USD": SimpleNamespace(key="synthetic-dataset")}
    disconnected = []
    monkeypatch.setattr(worker, "session_states", lambda items, **_: {key: {"market_session": "open", "next_session_at": None} for key in items})
    monkeypatch.setattr(worker, "recovery_requirements", lambda _: {"synthetic-dataset": 2})
    monkeypatch.setattr(worker, "begin_connection", lambda *_: 7)
    monkeypatch.setattr(worker, "renew", lambda _: True)
    monkeypatch.setattr(worker, "desired_datasets", lambda _: identities)
    monkeypatch.setattr(worker, "confirm_pages", lambda *_: None)
    monkeypatch.setattr(worker, "confirmation_error", lambda *_: None)
    monkeypatch.setattr(worker, "publish_event", lambda *_: None)
    monkeypatch.setattr(worker, "disconnected", lambda *args, **kwargs: disconnected.append((args, kwargs)))
    return identities, disconnected


def database_error(sqlstate="40P01"):
    cause = RuntimeError("private-account private-token private-price")
    cause.sqlstate = sqlstate
    return OperationalError("private SQL", {"token": "private-token"}, cause)


@pytest.mark.parametrize("stage,make_error,error_type,sqlstate,status", [
    ("stream", lambda: httpx.ReadTimeout("private-account private-token"), "ReadTimeout", "-", "timeout"),
    ("publish", database_error, "OperationalError", "40P01", "unavailable"),
    ("publish", lambda: TimeoutError("private-account private-token"), "TimeoutError", "-", "timeout"),
    ("publish", lambda: database_error("private-token"), "OperationalError", "-", "unavailable"),
])
def test_collect_logs_error_stage_type_and_safe_sqlstate(
        collecting, monkeypatch, caplog, stage, make_error, error_type, sqlstate, status):
    identities, disconnected = collecting
    error = make_error()

    class Adapter:
        account_id = "synthetic-account"

        def stream(self, *_args, **_kwargs):
            if stage == "stream":
                raise error
            yield {"type": "heartbeat"}

    if stage == "publish":
        def fail_publish(*_):
            raise error
        monkeypatch.setattr(worker, "publish_event", fail_publish)
    worker.collect(Adapter(), ("synthetic-account", "owner"), identities, threading.Event())
    record = next(r for r in caplog.records if r.message.startswith("pricing_stream_ended"))
    assert f"status={status}" in record.message
    assert f"stage={stage}" in record.message
    assert f"type={error_type}" in record.message
    assert f"sqlstate={sqlstate}" in record.message
    assert all(secret not in caplog.text for secret in ("private-account", "private-token", "private-price", "private SQL"))
    assert record.exc_info is None
    assert disconnected[0][0][-1].status == status


def test_maintenance_database_error_preserves_safe_diagnostic_fields(collecting, monkeypatch, caplog):
    identities, _ = collecting
    failed = threading.Event()

    def fail_confirmation(*_):
        failed.set()
        raise database_error()

    class Adapter:
        account_id = "synthetic-account"

        def stream(self, *_args, **_kwargs):
            assert failed.wait(2)
            raise httpx.ReadTimeout("private-token")
            yield

    monkeypatch.setattr(worker, "confirm_pages", fail_confirmation)
    worker.collect(Adapter(), ("synthetic-account", "owner"), identities, threading.Event())
    record = next(r for r in caplog.records if r.message.startswith("pricing_maintenance_failed"))
    assert "stage=confirmation" in record.message
    assert "type=OperationalError" in record.message and "sqlstate=40P01" in record.message
    assert "private-token" not in caplog.text and record.exc_info is None


def test_ownership_loss_is_visible_without_publishing_after_renew_failure(collecting, monkeypatch, caplog):
    identities, disconnected = collecting
    lost = threading.Event()
    published = []

    def cannot_renew(*_):
        lost.set()
        return False

    class Adapter:
        account_id = "synthetic-account"

        def stream(self, *_args, **_kwargs):
            assert lost.wait(2)
            yield {"type": "heartbeat"}

    monkeypatch.setattr(worker, "renew", cannot_renew)
    monkeypatch.setattr(worker, "publish_event", lambda *_: published.append(True))
    worker.collect(Adapter(), ("synthetic-account", "owner"), identities, threading.Event())
    assert not published and not disconnected
    assert "pricing_ownership_lost reason=lease_not_renewed" in caplog.text


def test_normal_stream_eof_is_visible_and_keeps_disconnect_backoff(collecting, caplog):
    identities, disconnected = collecting
    caplog.set_level(logging.INFO, logger=worker.__name__)

    class Adapter:
        account_id = "synthetic-account"

        def stream(self, *_args, **_kwargs):
            return iter(())

    worker.collect(Adapter(), ("synthetic-account", "owner"), identities, threading.Event())
    assert "pricing_stream_closed reason=eof epoch=7" in caplog.text
    assert disconnected[0][0][-1].status == "unavailable"
    assert not disconnected[0][1]["intentional"]


@pytest.mark.parametrize("mode", ["stream", "rest_batch"])
def test_confirmation_thread_reports_fault_and_quotes_cannot_clear_it(collecting, monkeypatch, mode):
    from alerts.market_contracts import RequestResult
    from test_oanda_stream import oanda_identity

    identities, _ = collecting
    reported = threading.Event()
    stopped = threading.Event()
    records = []

    def record(**value):
        records.append(value)
        if value["error"] == "OperationalError":
            reported.set()

    def fail_confirmation(*_):
        raise database_error()

    class Adapter:
        account_id = "synthetic-account"

        def stream(self, *_args, **_kwargs):
            assert reported.wait(2), "confirmation thread lost runtime reporting context"
            yield {"type": "heartbeat"}
            stopped.set()

        def page(self, *_):
            raise AssertionError("confirmation uses the patched owned entry point")

        def latest(self, *_args, **_kwargs):
            assert reported.wait(2), "REST confirmation lost runtime reporting context"
            return SimpleNamespace(result=RequestResult(status="data"))

    monkeypatch.setattr(worker, "confirm_pages", fail_confirmation)
    monkeypatch.setattr(worker.settings, "oanda_acquisition_mode", "stream")
    if mode == "rest_batch":
        identity = oanda_identity()
        identities = {identity.key: identity}
        monkeypatch.setattr(worker, "desired_for_mode", lambda _: identities)
        monkeypatch.setattr(worker, "closed_delay", lambda _: None)
        monkeypatch.setattr(worker, "publish_rest_batch", lambda *_args, **_kwargs: stopped.set())
    with reporting(SimpleNamespace(record=record)):
        collect = worker.collect_rest if mode == "rest_batch" else worker.collect
        collect(Adapter(), ("synthetic-account", "owner"), identities, stopped)
    assert len(records) >= 2
    assert all(row["state"] == "degraded" and row["error"] == "OperationalError" for row in records)


@pytest.mark.parametrize("failure", ["timeout", "eof"])
def test_stream_fault_is_preserved_during_waiting_for_retry(collecting, failure):
    identities, _ = collecting
    records = []

    class Adapter:
        account_id = "synthetic-account"

        def stream(self, *_args, **_kwargs):
            if failure == "timeout":
                raise httpx.ReadTimeout("private-token")
            return iter(())

    with reporting(SimpleNamespace(record=lambda **value: records.append(value))):
        worker.collect(Adapter(), ("synthetic-account", "owner"), identities, threading.Event())
    assert records[-1]["state"] == "degraded"
    assert records[-1]["error"] == ("timeout" if failure == "timeout" else "unavailable")
