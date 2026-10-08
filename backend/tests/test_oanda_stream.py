import hashlib
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer, ThreadingHTTPServer

import httpx
import pytest
from alerts.market_contracts import QuoteEvent
from alerts.oanda_stream import NDJSONDecoder, OandaPractice, price_event
from httpcore._backends.sync import SyncStream
from test_market_contracts import identity


def oanda_identity():
    return identity(source="oanda", channel="v20", environment="practice",
                    account_scope="sha256:" + hashlib.sha256(b"test-account").hexdigest(),
                    provider_symbol="EUR_USD")


def price():
    return {"type": "PRICE", "instrument": "EUR_USD", "time": "60.123456789",
            "bids": [{"price": "1.10001"}], "asks": [], "tradeable": False}


def test_ndjson_handles_every_chunk_boundary_and_multiple_lines():
    objects = [price(), {"type": "HEARTBEAT", "time": "61.0", "note": "心跳"}]
    content = ("\n" + "\r\n".join(json.dumps(row, ensure_ascii=False) for row in objects) + "\n").encode()
    for boundary in range(len(content) + 1):
        decoder = NDJSONDecoder()
        assert decoder.feed(content[:boundary]) + decoder.feed(content[boundary:]) == objects
        decoder.finish()
    decoder = NDJSONDecoder()
    parsed = []
    for byte in content:
        parsed.extend(decoder.feed(bytes([byte])))
    assert parsed == objects
    decoder.finish()


def test_unfinished_record_and_oversized_message_are_failures():
    decoder = NDJSONDecoder(max_bytes=20)
    with pytest.raises(ValueError, match="buffer"):
        decoder.feed(b"x" * 21)
    decoder = NDJSONDecoder()
    decoder.feed(b'{"type":')
    with pytest.raises(ValueError, match="unfinished"):
        decoder.finish()


def test_quote_has_one_sided_prices_source_clock_epoch_and_sequence():
    event = price_event(price(), {"EUR_USD": oanda_identity()}, epoch=4, sequence=7, received_at=62000)
    assert isinstance(event, QuoteEvent)
    assert event.ask is None and event.bid == "1.10001" and not event.tradeable
    assert event.source_time == 60123 and event.received_at == 62000
    assert (event.connection_epoch, event.sequence) == (4, 7)
    heartbeat = price_event({"type": "HEARTBEAT", "time": "61.0"}, {},
                            epoch=4, sequence=8, received_at=62000)
    assert heartbeat["type"] == "heartbeat" and heartbeat["source_time"] == 61000


def test_account_candles_confirm_complete_unsmoothed_bid_only():
    calls = []

    def handle(request):
        calls.append(request)
        assert "/accounts/test-account/instruments/EUR_USD/candles" in request.url.path
        assert request.url.params["price"] == "B" and request.url.params["smooth"] == "false"
        return httpx.Response(200, json={"instrument": "EUR_USD", "granularity": "M1", "candles": [
            {"time": "0.0", "complete": True, "bid": {"o": "1.1", "h": "1.2", "l": "1.0", "c": "1.1"}, "volume": 7},
            {"time": "60.0", "complete": False, "bid": {"o": "1.1", "h": "1.2", "l": "1.0", "c": "1.1"}, "volume": 3},
        ]})

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        adapter = OandaPractice(token="test", account_id="test-account", rest_client=client, clock=lambda: 125000)
        try:
            batch = adapter.page(oanda_identity(), 0, 120000)
        finally:
            adapter.close()
    assert len(calls) == 1 and len(batch.rows) == 1
    assert batch.rows[0].timestamp == 0 and batch.rows[0].volume == "7"
    assert batch.volume_kind == "price_count"


@pytest.mark.parametrize("code,status", [(401, "unauthorized"), (429, "rate_limited"), (503, "unavailable")])
def test_rest_errors_are_not_empty_success(database, code, status):
    with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(code))) as client:
        adapter = OandaPractice(token="test", account_id="test-account", rest_client=client)
        try:
            batch = adapter.page(oanda_identity(), 0, 120000)
        finally:
            adapter.close()
    assert batch.result.status == status and not batch.rows


def test_two_instruments_use_one_stream_and_snapshot():
    calls = []

    def handle(request):
        calls.append(request)
        assert request.url.params["instruments"] == "EUR_USD,XAU_USD"
        assert request.url.params["snapshot"] == "true"
        return httpx.Response(200, content=(json.dumps(price()) + "\n" +
            json.dumps({"type": "HEARTBEAT", "time": "61.0"}) + "\n").encode())

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        adapter = OandaPractice(token="test", account_id="test-account", stream_client=client,
                                clock=lambda: 62000)
        try:
            events = list(adapter.stream({"EUR_USD": oanda_identity(),
                                          "XAU_USD": oanda_identity()}, epoch=3))
        finally:
            adapter.close()
    assert len(calls) == 1 and len(events) == 2
    assert events[0].connection_epoch == 3 and events[1]["type"] == "heartbeat"


@pytest.mark.parametrize("phase", ["receive_headers", "receive_body"])
def test_stream_timeout_identifies_actual_http_phase_without_private_fields(caplog, phase):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            if phase == "receive_headers":
                time.sleep(0.15)
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", "1000")
            self.end_headers()
            self.wfile.write(b'{"type":"HEARTBEAT","time":"61.0"}\n')
            self.wfile.flush()
            time.sleep(0.15)

    server = HTTPServer(("127.0.0.1", 0), Handler)
    serving = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01})
    serving.start()
    # Preserve HTTPX/httpcore's real streaming and trace hooks; only reroute the
    # destination to the isolated local server, never contact the supplier.
    class LocalClient(httpx.Client):
        def stream(self, method, url, **kwargs):
            return super().stream(method, f"http://127.0.0.1:{server.server_port}/", **kwargs)

    try:
        with LocalClient(timeout=httpx.Timeout(0.05, connect=1), trust_env=False) as client:
            adapter = OandaPractice(token="private-token", account_id="private-account",
                                    stream_client=client, rest_client=client)
            events = adapter.stream({"EUR_USD": oanda_identity()}, epoch=9)
            if phase == "receive_body":
                assert next(events)["type"] == "heartbeat"
            with pytest.raises(httpx.ReadTimeout):
                list(events)
    finally:
        server.shutdown()
        serving.join(timeout=2)
        server.server_close()
    record = next(r for r in caplog.records if r.message.startswith("pricing_transport_failed"))
    assert f"phase={phase}" in record.message
    assert "type=ReadTimeout" in record.message and "epoch=9" in record.message
    assert f"records={int(phase == 'receive_body')}" in record.message
    assert "private-token" not in caplog.text and "private-account" not in caplog.text
    assert record.exc_info is None


def test_stream_http_auth_failure_keeps_status_without_response_secrets(caplog):
    with httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(
            401, json={"errorMessage": "private-token private-account"}))) as client:
        adapter = OandaPractice(token="private-token", account_id="private-account",
                                stream_client=client, rest_client=client)
        with pytest.raises(httpx.HTTPStatusError):
            list(adapter.stream({"EUR_USD": oanda_identity()}, epoch=11))
    record = next(r for r in caplog.records if r.message.startswith("pricing_transport_failed"))
    assert "phase=http_status" in record.message and "http_status=401" in record.message
    assert "private-token" not in caplog.text and "private-account" not in caplog.text


@pytest.mark.parametrize("failure", ["ConnectTimeout", "ConnectError"])
def test_proxy_tls_failure_does_not_poison_next_stream_pool(monkeypatch, caplog, failure):
    """Exercise the real CONNECT pool state left ACTIVE after TLS failure."""
    class Proxy(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_):
            pass

        def do_CONNECT(self):
            self.send_response(200)
            self.end_headers()

        def do_GET(self):
            body = b'{"type":"HEARTBEAT","time":"61.0"}\n'
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            self.wfile.flush()

    import httpcore

    server = ThreadingHTTPServer(("127.0.0.1", 0), Proxy)
    serving = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01})
    serving.start()
    handshakes = []

    def handshake(stream, *_, **__):
        handshakes.append(stream)
        if len(handshakes) == 1:
            raise getattr(httpcore, failure)("synthetic TLS failure")
        # Keep only TLS cryptography synthetic; socket, CONNECT, HTTPcore pool,
        # HTTPX timeout mapping and the adapter's reconnect are all real.
        return stream

    monkeypatch.setattr(SyncStream, "start_tls", handshake)
    real_client = httpx.Client

    def client(**kwargs):
        kwargs["timeout"] = httpx.Timeout(0.05, connect=1)
        return real_client(**kwargs)

    monkeypatch.setattr(httpx, "Client", client)
    adapter = OandaPractice(token="test", account_id="test-account",
                            proxy=f"http://127.0.0.1:{server.server_port}")
    try:
        with pytest.raises(getattr(httpx, failure)):
            list(adapter.stream({"EUR_USD": oanda_identity()}, epoch=1))
        assert "phase=tls route=proxy_tls" in caplog.text
        events = list(adapter.stream({"EUR_USD": oanda_identity()}, epoch=2))
        assert len(events) == 1 and events[0]["type"] == "heartbeat"
        assert len(handshakes) == 2
    finally:
        adapter.close()
        server.shutdown()
        serving.join(timeout=2)
        server.server_close()


def test_owned_stream_pool_closes_when_consumer_stops_early(monkeypatch):
    clients = []
    real_client = httpx.Client

    def client(**kwargs):
        kwargs["transport"] = httpx.MockTransport(lambda _: httpx.Response(
            200, content=b'{"type":"HEARTBEAT","time":"61.0"}\n'))
        result = real_client(**kwargs)
        clients.append(result)
        return result

    monkeypatch.setattr(httpx, "Client", client)
    with real_client() as rest:
        adapter = OandaPractice(token="test", account_id="test-account", rest_client=rest)
        try:
            for epoch in (1, 2):
                events = adapter.stream({}, epoch=epoch)
                assert next(events)["type"] == "heartbeat"
                events.close()
                assert clients[-1].is_closed
            assert len(clients) == 2 and not rest.is_closed
        finally:
            adapter.close()


@pytest.mark.parametrize("operation", ["catalog", "candles"])
@pytest.mark.parametrize("phase", ["receive_headers", "receive_body"])
def test_rest_timeout_logs_real_phase_without_secrets(caplog, operation, phase):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            if phase == "receive_body":
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", "1000")
                self.end_headers()
                self.wfile.write(b'{"private-token":"private-account"')
                self.wfile.flush()
            time.sleep(0.15)

    class LocalClient(httpx.Client):
        def send(self, request, **kwargs):
            request.url = httpx.URL(f"http://127.0.0.1:{server.server_port}/")
            return super().send(request, **kwargs)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    serving = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01})
    serving.start()
    try:
        with LocalClient(timeout=0.05, trust_env=False) as client:
            adapter = OandaPractice(token="private-token", account_id="test-account",
                                    rest_client=client, clock=lambda: 125000)
            try:
                if operation == "catalog":
                    with pytest.raises(httpx.ReadTimeout):
                        adapter.catalog()
                else:
                    batch = adapter.page(oanda_identity(), 0, 120000)
                    assert batch.result.status == "timeout" and not batch.rows
            finally:
                adapter.close()
    finally:
        server.shutdown()
        serving.join(timeout=2)
        server.server_close()
    record = next(r for r in caplog.records if r.message.startswith("oanda_rest_failed"))
    assert f"operation={operation}" in record.message
    assert f"phase={phase}" in record.message and "route=upstream" in record.message
    assert "type=ReadTimeout" in record.message
    assert record.exc_info is None
    assert all(secret not in caplog.text for secret in ("private-token", "private-account", "test-account"))


@pytest.mark.parametrize("operation", ["catalog", "candles"])
def test_rest_auth_diagnostics_preserve_fault_without_response_secrets(caplog, operation):
    with httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(
            401, json={"errorMessage": "private-token test-account"}))) as client:
        adapter = OandaPractice(token="private-token", account_id="test-account", rest_client=client)
        try:
            if operation == "catalog":
                with pytest.raises(httpx.HTTPStatusError):
                    adapter.catalog()
            else:
                assert adapter.page(oanda_identity(), 0, 120000).result.status == "unauthorized"
        finally:
            adapter.close()
    record = next(r for r in caplog.records if r.message.startswith("oanda_rest_failed"))
    assert f"operation={operation}" in record.message
    assert "phase=http_status" in record.message and "http_status=401" in record.message
    assert "body_kind=json" in record.message and record.exc_info is None
    assert all(secret not in caplog.text for secret in ("private-token", "test-account"))
