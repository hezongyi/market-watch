"""Real adapters recover one-off 401s without hiding auth faults or publishing twice."""

import json
import logging
import time
from contextlib import contextmanager
from types import SimpleNamespace

import httpx
import pytest
from alerts import oanda_auth, oanda_stream, provider_chart, providers
from alerts.config import settings
from alerts.oanda_rest_batch import CandleSpec, OandaRestBatch
from alerts.oanda_stream import OandaPractice
from alerts.provider_deadline import DeadlineBackend, request_deadline
from test_oanda_rest_batch import group
from test_oanda_stream import oanda_identity, price


@pytest.fixture
def clock(monkeypatch):
    stamp = [time.monotonic()]
    sleeps = []

    def sleep(seconds):
        stamp[0] += seconds
        sleeps.append(seconds)

    monkeypatch.setattr(oanda_auth, "time", SimpleNamespace(monotonic=lambda: stamp[0], sleep=sleep))
    monkeypatch.setattr(oanda_auth, "uniform", lambda *_: 1)
    return stamp, sleeps


def invoke(adapter, kind, **kwargs):
    if kind == "stream":
        return list(adapter.stream({"EUR_USD": oanda_identity()}, epoch=7, **kwargs))
    if kind == "latest":
        return adapter.latest([CandleSpec.from_dataset(oanda_identity())], generation=7,
                              sequence=2, demand_revision="original", **kwargs)
    return adapter.page(oanda_identity(), 0, 60000, **kwargs)


def success(kind):
    if kind == "stream":
        return httpx.Response(200, content=json.dumps(price()) + "\n")
    if kind == "latest":
        return httpx.Response(200, json={"latestCandles": [group()]})
    return httpx.Response(200, json={"candles": []})


@pytest.mark.parametrize("kind", ["page", "latest", "stream"])
def test_401_then_success_preserves_request_and_releases_slots(clock, monkeypatch, caplog, kind):
    stamp, sleeps = clock
    calls, slots = [], []
    active = [False]

    @contextmanager
    def slot(*_, **kwargs):
        assert not active[0]
        active[0] = True
        slots.append(kwargs)
        try:
            yield
        finally:
            active[0] = False

    original_sleep = oanda_auth.time.sleep

    def sleep(seconds):
        assert not active[0], "a retry wait must not hold an upstream slot"
        original_sleep(seconds)

    monkeypatch.setattr(oanda_auth.time, "sleep", sleep)
    monkeypatch.setattr(oanda_stream, "request_slot", slot)
    caplog.set_level(logging.INFO, logger=oanda_auth.__name__)

    def respond(request):
        assert active[0]
        calls.append((request.method, str(request.url), request.headers["authorization"]))
        return (httpx.Response(401, headers={"RequestID": "request-001"},
                json={"errorMessage": "Insufficient authorization to perform request."})
                if len(calls) == 1 else success(kind))

    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        cls = OandaRestBatch if kind == "latest" else OandaPractice
        adapter = cls(token="private-token", account_id="test-account", rest_client=client,
                      stream_client=client, clock=lambda: 125000)
        result = invoke(adapter, kind)
    assert len(calls) == len(slots) == 2 and calls[0] == calls[1]
    assert sum(sleeps) == pytest.approx(1)
    if kind == "stream":
        assert len(result) == 1 and result[0].connection_epoch == 7 and result[0].sequence == 1
    else:
        assert result.result.successful
        if kind == "latest":
            assert (result.generation, result.sequence, result.demand_revision) == (7, 2, "original")
    assert "attempt=1 http_status=401 outcome=refused" in caplog.text
    assert "attempt=2 http_status=200 outcome=recovered" in caplog.text
    assert "request_id=request-001 reason=insufficient_authorization" in caplog.text
    assert all(secret not in caplog.text for secret in ("private-token", "test-account", "Bearer"))


@pytest.mark.parametrize("kind", ["page", "latest", "stream"])
@pytest.mark.parametrize("status,attempts", [(401, 3), (403, 1), (400, 1), (503, 1)])
def test_terminal_fault_keeps_status_and_bounded_attempts(clock, kind, status, attempts):
    calls = []

    def respond(request):
        calls.append(request)
        return httpx.Response(status)

    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        cls = OandaRestBatch if kind == "latest" else OandaPractice
        adapter = cls(token="private-token", account_id="test-account", rest_client=client,
                      stream_client=client)
        if kind == "stream":
            with pytest.raises(httpx.HTTPStatusError) as error:
                invoke(adapter, kind)
            assert error.value.response.status_code == status
        else:
            result = invoke(adapter, kind)
            assert not result.result.successful
            if status in (401, 403):
                assert result.result.status == "unauthorized"
    assert len(calls) == attempts
    assert sum(clock[1]) == pytest.approx(3 if status == 401 else 0)


@pytest.mark.parametrize("reason", ["cancel", "budget"])
def test_rest_cancellation_or_deadline_prevents_retry(clock, reason):
    calls = []

    def respond(request):
        calls.append(request)
        return httpx.Response(401)

    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        adapter = OandaRestBatch(token="test", account_id="test-account", rest_client=client)
        result = invoke(adapter, "latest", deadline=clock[0][0] + (0.5 if reason == "budget" else 15),
                        cancelled=lambda: reason == "cancel" and bool(calls))
    assert len(calls) == 1 and not result.result.successful
    assert result.result.status == ("timeout" if reason == "cancel" else "unauthorized")
    assert not clock[1]


@pytest.mark.parametrize("token,account", [("", "test-account"), ("test", " ")])
def test_missing_credentials_do_not_retry(clock, token, account):
    retry = oanda_auth.AuthRetry(operation="test", token=token, account=account,
                                deadline=clock[0][0] + 15)
    retry.observe(httpx.Response(401))
    assert retry.wait() is False
    assert not clock[1]


@pytest.mark.parametrize("kind", ["adapter", "history"])
def test_outer_deadline_is_not_reset_for_each_attempt(clock, monkeypatch, kind):
    monkeypatch.setattr(settings, "oanda_token", "test")
    monkeypatch.setattr(settings, "oanda_account_id", "test-account")
    calls = []
    with httpx.Client(transport=httpx.MockTransport(
            lambda request: calls.append(request) or httpx.Response(401))) as client:
        adapter = OandaPractice(token="test", account_id="test-account", rest_client=client)
        with request_deadline(clock[0][0] + 0.5):
            if kind == "history":
                with pytest.raises(httpx.HTTPStatusError):
                    providers.fetch_oanda("EUR_USD", client=client)
            else:
                assert adapter.rest_get("https://api-fxpractice.oanda.com/v3/accounts").status_code == 401
    assert len(calls) == 1 and not clock[1]


def test_untrusted_error_fields_never_enter_log(clock, caplog):
    caplog.set_level(logging.INFO, logger=oanda_auth.__name__)
    with httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(401,
            headers={"RequestID": "private-token"}, json={"errorMessage": "private-token test-account"}))) as client:
        adapter = OandaPractice(token="private-token", account_id="test-account", rest_client=client)
        assert invoke(adapter, "page").result.status == "unauthorized"
    assert "request_id=redacted reason=unrecognized" in caplog.text
    assert all(secret not in caplog.text for secret in ("private-token", "test-account"))


def test_established_stream_is_never_replayed(clock):
    calls = []

    class BrokenStream(httpx.SyncByteStream):
        def __iter__(self):
            yield (json.dumps(price()) + "\n").encode()
            response = httpx.Response(401, request=httpx.Request("GET", "https://example.test"))
            response.raise_for_status()

    def respond(request):
        calls.append(request)
        return httpx.Response(200, stream=BrokenStream())

    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        adapter = OandaPractice(token="test", account_id="test-account", stream_client=client,
                                rest_client=client)
        events = adapter.stream({"EUR_USD": oanda_identity()}, epoch=7)
        assert next(events).sequence == 1
        with pytest.raises(httpx.HTTPStatusError):
            next(events)
    assert len(calls) == 1 and not clock[1]


def test_owned_stream_closes_each_refused_pool(clock, monkeypatch):
    clients, calls = [], []
    real_client = httpx.Client

    def respond(request):
        calls.append(request)
        return httpx.Response(401) if len(calls) < 3 else success("stream")

    def client(**kwargs):
        kwargs["transport"] = httpx.MockTransport(respond)
        result = real_client(**kwargs)
        clients.append(result)
        return result

    monkeypatch.setattr(httpx, "Client", client)
    with real_client() as rest:
        adapter = OandaPractice(token="test", account_id="test-account", rest_client=rest)
        assert len(invoke(adapter, "stream")) == 1
    assert len(clients) == 3 and all(client.is_closed for client in clients)
    assert adapter.stream_client is None


def test_owned_proxy_stream_keeps_deadline_transport(monkeypatch):
    real_client = httpx.Client
    checked = []

    def client(**kwargs):
        result = real_client(**kwargs)
        selected = result._transport_for_url(httpx.URL("https://stream-fxpractice.oanda.com"))
        assert selected is result._transport
        assert isinstance(selected._pool._network_backend, DeadlineBackend)
        assert "proxy" not in kwargs
        checked.append(True)
        result.close()
        raise httpx.ConnectError("synthetic connect failure")

    monkeypatch.setattr(httpx, "Client", client)
    with real_client() as rest:
        adapter = OandaPractice(token="test", account_id="test-account", rest_client=rest,
                                proxy="http://127.0.0.1:9")
        with pytest.raises(httpx.ConnectError):
            invoke(adapter, "stream")
    assert checked == [True]


@pytest.mark.parametrize("kind", ["chart", "history", "catalog"])
def test_other_read_paths_share_auth_retry_boundary(clock, monkeypatch, kind):
    monkeypatch.setattr(settings, "oanda_token", "test")
    monkeypatch.setattr(settings, "oanda_account_id", "test-account")
    calls = []

    def respond(request):
        calls.append(str(request.url))
        return httpx.Response(401) if len(calls) == 1 else httpx.Response(200, json={
            "candles": [], "instruments": []})

    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        if kind == "chart":
            assert provider_chart._request(client, "https://api-fxpractice.oanda.com/v3/candles",
                params={}, deadline=clock[0][0] + 15) == {"candles": [], "instruments": []}
        elif kind == "history":
            assert providers.fetch_oanda("EUR_USD", client=client)["rows"] == []
        else:
            assert providers.fetch_oanda_catalog(client=client) == []
    assert len(calls) == 2 and calls[0] == calls[1] and sum(clock[1]) == pytest.approx(1)
