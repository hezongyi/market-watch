"""Real CONNECT pool recovery and shared-budget behavior without external suppliers."""
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpcore
import httpx
import pytest
from alerts import provider_transport as transport
from alerts.config import settings
from alerts.providers import fetch_binance
from httpcore._backends.sync import SyncStream


@pytest.fixture
def failing_tls_proxy(monkeypatch):
    class Proxy(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        def log_message(self, *_):
            pass
        def do_CONNECT(self):
            self.send_response(200)
            self.end_headers()
        def do_GET(self):
            body = b'[]' if 'binance' in self.headers.get('Host', '') else b'{"candles":[]}'
            self.send_response(200)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
    server = ThreadingHTTPServer(('127.0.0.1', 0), Proxy)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .01})
    thread.start()
    connections = []
    def handshake(stream, *args, **kwargs):
        connections.append(stream)
        if len(connections) == 1:
            raise httpcore.ConnectError('[SSL: UNEXPECTED_EOF_WHILE_READING] controlled')
        return stream  # Crypto only is synthetic; real socket/CONNECT/pool/trace remain.
    monkeypatch.setattr(SyncStream, 'start_tls', handshake)
    transport.close_clients()
    try:
        yield f'http://127.0.0.1:{server.server_port}', connections
    finally:
        transport.close_clients()
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()


def test_binance_rotates_failed_connect_pool_and_retries_with_new_socket(failing_tls_proxy, monkeypatch, caplog):
    proxy, connections = failing_tls_proxy
    monkeypatch.setattr(settings, 'binance_proxy', proxy)
    from alerts.market_resources import lane
    # Real lane-local pool, synthetic quota seam to count both reservations.
    slots = []
    @contextmanager
    def slot(source, **kwargs):
        slots.append((source, kwargs['deadline']))
        yield
    monkeypatch.setattr('alerts.market_resources.request_slot', slot)
    with lane('realtime'):
        failed = transport.pooled_client('binance')
        assert fetch_binance(mode='quote')['rows'] == []
        assert transport.pooled_client('binance') is not failed and failed.is_closed
    assert len(connections) == 2 and connections[0] is not connections[1]
    assert len(slots) == 2 and slots[0] == slots[1]
    assert 'phase=proxy.start_tls' in caplog.text
    assert proxy not in caplog.text


def test_oanda_confirmation_rotates_failed_pool_without_extra_supplier_attempt(failing_tls_proxy):
    from alerts.oanda_stream import OandaPractice
    from test_oanda_stream import oanda_identity
    proxy, connections = failing_tls_proxy
    adapter = OandaPractice(token='test', account_id='test-account', proxy=proxy, clock=lambda: 125000)
    try:
        first = adapter.page(oanda_identity(), 60000, 120000)
        assert first.result.status == 'unavailable' and first.checkpoint == 60000
        second = adapter.page(oanda_identity(), 60000, 120000)
        assert second.result.status == 'empty_success'
        assert len(connections) == 2 and connections[0] is not connections[1]
    finally:
        adapter.close()


def test_binance_total_deadline_prevents_second_request(monkeypatch):
    clock = [10.0]
    monkeypatch.setattr(transport.time, 'monotonic', lambda: clock[0])
    calls = []
    def fail(request):
        calls.append(request)
        clock[0] = 25.0
        raise httpx.ConnectError('controlled', request=request)
    with httpx.Client(transport=httpx.MockTransport(fail)) as client:
        with pytest.raises(httpx.ConnectError):
            fetch_binance(client=client)
    assert len(calls) == 1


def test_market_network_errors_are_classified_without_url_or_empty_text(database, monkeypatch):
    from alerts import market
    from alerts.storage import Audit, Instrument
    from sqlalchemy import select
    def fail(*args):
        raise httpx.ReadTimeout('')
    market.once(symbol='BTCUSDT', fetcher=fail)
    with database.begin() as db:
        inst = db.get(Instrument, 'BTCUSDT')
        error = db.scalar(select(Audit).where(Audit.kind == 'market_error'))
        assert inst.error == 'ReadTimeout: network_failure'
        assert error.details['error_type'] == 'ReadTimeout'
    request = httpx.Request('GET', 'https://private.test/account-secret')
    error = httpx.HTTPStatusError('private account/token', request=request, response=httpx.Response(401))
    assert transport.error_detail(error) == 'HTTPStatusError: HTTP 401'


@pytest.mark.parametrize('failure', ['certificate', 'unauthorized', 'rate_limited'])
def test_binance_native_chart_does_not_retry_protected_failures(failure):
    import ssl
    import time

    from alerts.provider_chart import _request
    requests = []
    def receive(request):
        requests.append(request)
        if failure == 'certificate':
            raise httpx.ConnectError('controlled', request=request) from ssl.SSLCertVerificationError('controlled')
        return httpx.Response(401 if failure == 'unauthorized' else 429)
    with httpx.Client(transport=httpx.MockTransport(receive)) as client:
        with pytest.raises(httpx.HTTPError):
            _request(client, 'https://data-api.binance.vision/api/v3/klines', params={}, deadline=time.monotonic()+3)
    assert len(requests) == 1


@pytest.mark.parametrize('error_type', [httpx.ReadError, httpx.RemoteProtocolError, httpx.ReadTimeout])
def test_binance_native_chart_rotates_pool_for_retryable_read_failure(monkeypatch, error_type):
    import time

    from alerts.provider_chart import _request

    requests, discarded = [], []
    def receive(request):
        requests.append(request)
        if len(requests) == 1:
            raise error_type('controlled', request=request)
        return httpx.Response(200, json=[])
    monkeypatch.setattr('alerts.provider_chart.discard_client', discarded.append)
    with httpx.Client(transport=httpx.MockTransport(receive)) as client:
        assert _request(client, 'https://data-api.binance.vision/api/v3/klines', params={},
                        deadline=time.monotonic()+3) == []
        assert discarded == [client]
    assert len(requests) == 2
