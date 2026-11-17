import httpx
import pytest
from alerts.dukascopy_history import DukascopyHistory
from test_market_contracts import identity


def jsonp(request, rows):
    import json

    return httpx.Response(200, text=request.url.params["jsonp"] + "(" + json.dumps(rows) + ");")


def test_real_sdk_single_page_half_open_clipping_and_exact_prices():
    calls = []

    def handle(request):
        calls.append(request)
        assert request.url.params["instrument"] == "EUR/USD"
        assert request.url.params["offer_side"] == "B"
        assert request.url.params["interval"] == "1MIN"
        return jsonp(request, [[0, 1.10001, 1.12, 1.09, 1.11, 6.3],
                               [60000, 1.10, 1.12, 1.09, 1.11, 7.0],
                               [120000, 1.10, 1.12, 1.09, 1.11, 8.0]])

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        adapter = DukascopyHistory(client=client, clock=lambda: 125000)
        batch = adapter.page(identity(), 0, 120000)
    assert len(calls) == 1
    assert [row.timestamp for row in batch.rows] == [0, 60000]
    assert batch.rows[0].open == "1.10001" and batch.rows[0].volume == "6.3"
    assert batch.checkpoint == 120000
    assert batch.result.status == "data"


def test_full_page_checkpoint_can_resume_without_repeating_last_minute():
    calls = []

    def handle(request):
        start = int(request.url.params["last_update"])
        calls.append(start)
        return jsonp(request, [[start + i * 60000, "1.1", "1.2", "1.0", "1.1", 1]
                               for i in range(2)])

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        adapter = DukascopyHistory(client=client, page_size=2)
        first = adapter.page(identity(), 0, 240000)
        second = adapter.page(identity(), first.checkpoint, 240000)
    assert calls == [0, 120000]
    assert first.checkpoint == 120000 and second.checkpoint == 240000
    assert [row.timestamp for row in (*first.rows, *second.rows)] == [0, 60000, 120000, 180000]


@pytest.mark.parametrize("code,status", [(429, "rate_limited"), (401, "unauthorized"), (503, "unavailable")])
def test_http_error_never_becomes_empty_success_or_sdk_retry(code, status):
    calls = []

    def handle(request):
        calls.append(request)
        return httpx.Response(code, headers={"Retry-After": "30"})

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        batch = DukascopyHistory(client=client, clock=lambda: 1000).page(identity(), 0, 120000)
    assert len(calls) == 1
    assert batch.result.status == status
    assert batch.rows == () and batch.checkpoint == 0
    if code == 429:
        assert batch.result.retry_at == 31000


def test_empty_page_terminates_without_sdk_empty_index_failure():
    calls = []

    def handle(request):
        calls.append(request)
        return jsonp(request, [])

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        result = DukascopyHistory(client=client).page(identity(), 0, 120000)
    assert len(calls) == 1 and result.result.status == "empty_success"
    assert result.checkpoint == 120000
    assert "coverage" not in result.ingestion_payload()


@pytest.mark.parametrize("rows", [
    [[60000, 1, 2, 1, 1, 0], [0, 1, 2, 1, 1, 0]],
    [[0, 1, 2, 1, 1, 0], [0, 1, 2, 1, 1, 0]],
    [[0, 1]], {"error": "not data"}, [[0, 1, 0, 1, 1, 0]],
])
def test_malformed_source_page_is_structured_failure(rows):
    with httpx.Client(transport=httpx.MockTransport(lambda request: jsonp(request, rows))) as client:
        result = DukascopyHistory(client=client).page(identity(), 0, 120000)
    assert result.result.status == "invalid_payload" and not result.rows


def test_timeout_is_not_empty_success():
    def timeout(request):
        raise httpx.ReadTimeout("contains private proxy URL")

    with httpx.Client(transport=httpx.MockTransport(timeout)) as client:
        result = DukascopyHistory(client=client).page(identity(), 0, 120000)
    assert result.result.status == "timeout"
    assert "private" not in result.model_dump_json()


def test_shared_budget_timeout_does_not_enter_sdk_retry_path(monkeypatch):
    from contextlib import contextmanager

    @contextmanager
    def unavailable(*args):
        raise TimeoutError("shared cooldown")
        yield

    monkeypatch.setattr("alerts.dukascopy_history.request_slot", unavailable)
    with httpx.Client(transport=httpx.MockTransport(lambda request: pytest.fail("must not fetch"))) as client:
        result = DukascopyHistory(client=client).page(identity(), 0, 120000)
    assert result.result.status == "timeout" and result.checkpoint == 0


@pytest.mark.parametrize("failure", ["connect_tls", "pool"])
def test_owned_proxy_pool_recovers_after_failed_connect_tls(monkeypatch, caplog, failure):
    """A TLS failure after CONNECT can leave HTTPcore's only tunnel active.

    Exercise the real HTTPX/HTTPcore proxy pool, then retry through the same
    history adapter. Reusing the poisoned pool would produce PoolTimeout.
    """
    import httpcore

    clients, streams = [], []
    original_client = httpx.Client

    class ProxyStream(httpcore.NetworkStream):
        closed = False

        def read(self, max_bytes, timeout=None):
            return b"HTTP/1.1 200 Connection established\r\n\r\n"

        def write(self, buffer, timeout=None):
            pass

        def start_tls(self, ssl_context, server_hostname=None, timeout=None):
            raise httpcore.ConnectTimeout("private proxy credentials must not be logged")

        def close(self):
            self.closed = True

        def get_extra_info(self, info):
            return None

    class ProxyBackend(httpcore.NetworkBackend):
        def connect_tcp(self, *args, **kwargs):
            stream = ProxyStream()
            streams.append(stream)
            return stream

    def make_client(**kwargs):
        if not clients and failure == "connect_tls":
            transport = httpx.HTTPTransport(proxy="http://proxy.invalid:8080",
                limits=httpx.Limits(max_connections=1))
            transport._pool._network_backend = ProxyBackend()
        elif not clients:
            def exhausted_pool(request):
                raise httpx.PoolTimeout("private proxy credentials must not be logged")

            transport = httpx.MockTransport(exhausted_pool)
        else:
            transport = httpx.MockTransport(lambda request: jsonp(request, [
                [0, "1.1", "1.2", "1.0", "1.1", 1]]))
        client = original_client(transport=transport, timeout=.01, trust_env=False)
        clients.append(client)
        return client

    monkeypatch.setattr("alerts.dukascopy_history.httpx.Client", make_client)
    adapter = DukascopyHistory(proxy="http://proxy.invalid:8080")
    try:
        failed = adapter.page(identity(), 0, 120000)
        assert failed.result.status == "timeout" and failed.checkpoint == 0
        assert len(streams) == (1 if failure == "connect_tls" else 0)
        recovered = adapter.page(identity(), 0, 120000)
        assert recovered.result.status == "data", recovered.result
        assert recovered.checkpoint == 120000 and len(recovered.rows) == 1
        assert len(clients) == 2 and clients[0].is_closed
        if streams:
            assert streams[0].closed
        assert f"error_type={'ConnectTimeout' if failure == 'connect_tls' else 'PoolTimeout'}" in caplog.text
        assert "client_reset=True" in caplog.text
        assert "private proxy" not in caplog.text
    finally:
        adapter.close()


def test_borrowed_client_transport_failure_is_not_closed(caplog):
    def timeout(request):
        raise httpx.PoolTimeout("private proxy credentials must not be logged")

    with httpx.Client(transport=httpx.MockTransport(timeout)) as client:
        result = DukascopyHistory(client=client).page(identity(), 0, 120000)
        assert result.result.status == "timeout" and not client.is_closed
    assert "error_type=PoolTimeout" in caplog.text and "phase=pool" in caplog.text
    assert "client_reset=False" in caplog.text and "private proxy" not in caplog.text
