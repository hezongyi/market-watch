"""Real resolve route: temporary supplier failures never become unknown symbols."""
import time
from types import SimpleNamespace

import httpx
import pytest
from alerts import api as api_module
from alerts import provider_yahoo, yahoo_catalog
from fastapi import HTTPException
from fastapi.testclient import TestClient


@pytest.mark.parametrize("failure,status,code,retryable", [
    (provider_yahoo.YahooError("request_failed", "Yahoo 暂不可用"), 503, "request_failed", True),
    (provider_yahoo.YahooError("rate_limited", "Yahoo 限流"), 503, "rate_limited", True),
    (provider_yahoo.YahooError("authentication", "Yahoo 认证失败"), 503, "authentication", False),
    (provider_yahoo.YahooError("configuration", "Yahoo 未配置"), 503, "configuration", False),
    (TimeoutError("busy"), 503, "timeout", True),
    (HTTPException(404, "未知 Yahoo 品种"), 404, "unknown_symbol", False),
])
def test_resolve_supplier_failure(database, monkeypatch, failure, status, code, retryable):
    def unavailable(*args, **kwargs):
        raise failure
    monkeypatch.setattr(yahoo_catalog, "chart_metadata", unavailable)
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app, raise_server_exceptions=False) as client:
            response = client.post("/api/market-data/resolve", json={
                "instrument": provider_yahoo.stable_id("AAPL"),
                "series_kind": "provider", "timeframe": "M1"})
        assert response.status_code == status
        detail = response.json()["detail"]
        assert detail["code"] == code
        assert detail["retryable"] is retryable
        if code == "rate_limited":
            assert int(response.headers["Retry-After"]) > 0
    finally:
        api_module.app.dependency_overrides.pop(api_module.authenticated, None)


@pytest.mark.parametrize("failure", [TimeoutError("private"), httpx.ReadTimeout("private")])
def test_active_cooldown_survives_slot_timeout(database, monkeypatch, failure):
    from alerts import provider_errors, storage

    monkeypatch.setattr(provider_errors, "now_ms", lambda: 100_000)
    with storage.transaction() as db:
        db.add(storage.Preference(key="upstream_slots:yahoo", value={"cooldown_until": 160_100}))
    response = provider_errors.resolve_error(failure)
    assert response.status_code == 503
    assert response.detail["code"] == "rate_limited"
    assert response.headers["Retry-After"] == "61"
    assert "private" not in str(response.detail)


def test_adapter_diagnostic_does_not_log_exception_or_proxy(database, monkeypatch, caplog):
    from alerts import provider_yahoo as yahoo

    session = SimpleNamespace()
    monkeypatch.setattr(yahoo.settings, "yahoo_enabled", True)
    monkeypatch.setattr(yahoo.settings, "yahoo_proxy", "http://private-user:private-password@proxy.invalid")
    monkeypatch.setattr(yahoo, "sdk_session", lambda: session)
    monkeypatch.setattr(yahoo, "YfData", lambda **_: SimpleNamespace(cache_get=SimpleNamespace(cache_clear=lambda: None)))
    monkeypatch.setattr(yahoo, "_LAST_START", 0)
    with pytest.raises(yahoo.YahooError) as caught:
        with yahoo._operation(time.monotonic() + 2, stage="metadata"):
            session.last_status = 502
            raise ConnectionError("http://private-user:private-password@proxy.invalid cookie=secret")
    assert caught.value.status == "request_failed"
    record = next(record for record in caplog.records if "yahoo_operation_failed" in record.message)
    assert "stage=metadata exception_class=ConnectionError upstream_status=502" in record.message
    assert "attempt_id=" in record.message
    assert "private" not in record.message and "secret" not in record.message
