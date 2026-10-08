import hashlib
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import httpx
import pytest
from alerts.market_contracts import QuoteEvent
from alerts.oanda_stream import NDJSONDecoder, OandaPractice, price_event
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
