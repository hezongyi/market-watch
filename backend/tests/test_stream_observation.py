"""Verification counters distinguish real pipeline stalls without changing it."""

import importlib.util
import json
import sys
import threading
import time
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
import pytest
from alerts import live_pricing as live
from alerts import oanda_worker, storage
from alerts.oanda_stream import OandaPractice
from alerts.storage import LiveState
from test_live_pricing import quote
from test_live_pricing import running as _running
from test_oanda_stream import oanda_identity

VERIFICATION = Path(__file__).resolve().parents[2] / "docs/verification/oanda-stream-isolated"
running = _running
sys.path.insert(0, str(VERIFICATION))
spec = importlib.util.spec_from_file_location("stream_observation", VERIFICATION / "stream_observation.py")
observation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observation)


def record(source="121.0"):
    return {"type": "PRICE", "instrument": "EUR_USD", "time": source,
            "bids": [{"price": "1.10"}], "asks": [{"price": "1.40"}], "tradeable": True}


@contextmanager
def supplier(mode):
    stopped = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            if mode == "headers":
                stopped.wait(3)
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.end_headers()
            try:
                if mode == "partial":
                    for part in (b'{"type":', b'"HEARTBEAT",', b'"time":"121.0"'):
                        self.wfile.write(part)
                        self.wfile.flush()
                        stopped.wait(0.02)
                else:
                    self.wfile.write(json.dumps(record()).encode()+b"\n")
                    self.wfile.flush()
                stopped.wait(3)
            except (BrokenPipeError, ConnectionResetError):
                pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/"
    finally:
        stopped.set()
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)


@pytest.mark.parametrize("mode", ["headers", "body", "partial"])
def test_actual_stream_boundaries_distinguish_header_body_and_incomplete_record(mode, monkeypatch):
    original = httpx.Client.stream
    registry = observation.ObservationRegistry({"EUR_USD": "EURUSD"})
    published = []
    monkeypatch.setattr(oanda_worker, "publish_event", lambda *args: published.append(args[2]) or "accepted")
    with supplier(mode) as url:
        monkeypatch.setattr(httpx.Client, "stream", lambda client, method, _url, **kw:
                            original(client, method, url, **kw))
        with httpx.Client(trust_env=False, timeout=0.07) as client:
            adapter = OandaPractice(token="synthetic", account_id="test-account",
                                    stream_client=client, rest_client=client)
            with observation.observe_pipeline(registry):
                with pytest.raises(httpx.ReadTimeout):
                    for event in adapter.stream({"EUR_USD": oanda_identity()}, epoch=1):
                        oanda_worker.publish_event(None, 1, event, {})
    snapshot = registry.snapshot()["epochs"][0]
    assert snapshot["network"]["read_failures"] == 1
    assert snapshot["accounting_valid"] and snapshot["end"] == "error"
    if mode == "headers":
        assert snapshot["chunks"] == snapshot["records"] == snapshot["yielded"] == 0
    elif mode == "body":
        assert snapshot["chunks"] >= 1 and snapshot["records"] == snapshot["yielded"] == 1
        assert snapshot["symbols"]["EURUSD"]["accepted"] == 1 and len(published) == 1
        assert snapshot["buffer_bytes"] == 0
    else:
        assert snapshot["chunks"] >= 2 and snapshot["records"] == 0
        assert snapshot["buffer_peak_bytes"] == snapshot["buffer_bytes"] > 0
        assert not published
    assert all(secret not in json.dumps(snapshot) for secret in ("test-account", '"bid"', '"ask"'))


def decoded(pipeline, event):
    from alerts.oanda_stream import NDJSONDecoder

    decoder = NDJSONDecoder()
    data = json.dumps(record(str(event.source_time / 1000))).encode()+b"\n"
    pipeline.decoded(data, decoder, decoder.feed(data), pipeline.clock())
    pipeline.yielded(event)


def test_committed_filters_and_rollbacks_have_exact_receive_accounting(running, monkeypatch):
    factory, ownership, epoch, identities = running
    identity = identities["EUR_USD"]
    pipeline = observation.PipelineObservation(epoch, {"EUR_USD": "EURUSD"})
    events = [quote(identity, epoch, seq=5), quote(identity, epoch, seq=4, source=120000),
              quote(identity, epoch, seq=5, source=122000), quote(identity, epoch, seq=6),
              quote(identity, epoch, seq=7, source=122000)]
    for event in events:
        decoded(pipeline, event)
        pipeline.publish(live.publish_event, ownership, epoch, event, identities)
    snapshot = pipeline.snapshot()
    row = snapshot["symbols"]["EURUSD"]
    assert row["received"] == 5 and row["accepted"] == 2 and row["pending"] == 0
    assert all(row[name] == 1 for name in observation.OUTCOMES[1:])
    assert snapshot["accounting_valid"]

    # A real flush succeeds, then an actual transaction rollback must not report acceptance.
    original_transaction = storage.transaction

    @contextmanager
    def rollback_after_flush():
        with original_transaction() as db:
            yield db
            db.flush()
            raise RuntimeError("private SQL private-price")

    monkeypatch.setattr(live, "transaction", rollback_after_flush)
    event = quote(identity, epoch, seq=8, source=123000)
    decoded(pipeline, event)
    with pytest.raises(RuntimeError):
        pipeline.publish(live.publish_event, ownership, epoch, event, identities)
    assert pipeline.snapshot()["symbols"]["EURUSD"]["accepted"] == 2
    assert pipeline.snapshot()["symbols"]["EURUSD"]["errors"] == 1
    assert pipeline.snapshot()["accounting_valid"]
    with factory.begin() as db:
        assert db.get(LiveState, identity.key).quote["source_time"] == 122000
    assert "private" not in json.dumps(pipeline.snapshot())


def test_expired_owner_is_an_error_not_an_accept_or_normal_reject(running):
    _, ownership, epoch, identities = running
    identity = identities["EUR_USD"]
    pipeline = observation.PipelineObservation(epoch, {"EUR_USD": "EURUSD"})
    event = quote(identity, epoch)
    decoded(pipeline, event)
    with pytest.raises(TimeoutError):
        pipeline.publish(lambda *args: live.publish_event(*args, now=155001),
                         ownership, epoch, event, identities)
    row = pipeline.snapshot()["symbols"]["EURUSD"]
    assert row["received"] == row["errors"] == row["fencing_or_timeout_errors"] == 1
    assert all(row[name] == 0 for name in observation.OUTCOMES)
    assert row["pending"] == 0 and pipeline.snapshot()["accounting_valid"]


def test_closing_before_all_decoded_prices_yield_are_accounted_and_wrappers_restore(monkeypatch):
    from alerts import oanda_stream

    identity = oanda_identity()
    original_feed = oanda_stream.NDJSONDecoder.feed

    def stream(*_, **__):
        decoder = oanda_stream.NDJSONDecoder()
        records = decoder.feed((json.dumps(record())+"\n").encode()*2)
        for sequence, raw in enumerate(records, 1):
            yield oanda_stream.price_event(raw, {"EUR_USD": identity},
                epoch=1, sequence=sequence, received_at=122000)

    monkeypatch.setattr(oanda_stream.OandaPractice, "stream", stream)
    monkeypatch.setattr(oanda_worker, "publish_event", lambda *args: "accepted")
    original_publish = oanda_worker.publish_event
    registry = observation.ObservationRegistry({"EUR_USD": "EURUSD"})
    adapter = object.__new__(OandaPractice)
    with observation.observe_pipeline(registry):
        iterator = adapter.stream({"EUR_USD": identity}, epoch=1)
        event = next(iterator)
        oanda_worker.publish_event(None, 1, event, {})
        iterator.close()
    assert oanda_stream.NDJSONDecoder.feed is original_feed
    assert oanda_stream.OandaPractice.stream is stream
    assert oanda_worker.publish_event is original_publish
    row = registry.snapshot()["epochs"][0]["symbols"]["EURUSD"]
    assert row["received"] == 2 and row["delivered"] == row["accepted"] == 1
    assert row["errors"] == row["cancelled_before_publish"] == 1 and row["pending"] == 0
    assert registry.snapshot()["epochs"][0]["accounting_valid"]


def test_slow_publish_is_visible_while_reading_is_paused(monkeypatch, tmp_path):
    from alerts import oanda_stream

    entered, release, finished = threading.Event(), threading.Event(), threading.Event()
    identity = oanda_identity()

    def stream(*_, **__):
        decoder = oanda_stream.NDJSONDecoder()
        raw = decoder.feed(json.dumps(record()).encode()+b"\n")[0]
        yield oanda_stream.price_event(raw, {"EUR_USD": identity}, epoch=1, sequence=1, received_at=122000)

    def publish(*_):
        entered.set()
        assert release.wait(2)
        return "accepted"

    monkeypatch.setattr(oanda_stream.OandaPractice, "stream", stream)
    monkeypatch.setattr(oanda_worker, "publish_event", publish)
    registry = observation.ObservationRegistry({"EUR_USD": "EURUSD"})
    adapter = object.__new__(OandaPractice)

    def work():
        try:
            for event in adapter.stream({"EUR_USD": identity}, epoch=1):
                oanda_worker.publish_event(None, 1, event, {})
        finally:
            finished.set()

    with observation.observe_pipeline(registry):
        recorder = observation.SnapshotRecorder(registry.snapshot, tmp_path / "observation.jsonl", interval=0.01)
        recorder.start()
        thread = threading.Thread(target=work)
        thread.start()
        try:
            assert entered.wait(2)
            time.sleep(0.03)
            snapshot = registry.snapshot()["epochs"][0]
            assert snapshot["publish_active_ms"] >= 20
            assert snapshot["next_active_ms"] == snapshot["network"]["active_reads"] == 0
            assert snapshot["symbols"]["EURUSD"]["pending"] == 1
            assert snapshot["symbols"]["EURUSD"]["accepted"] == 0
            assert any(epoch["publish_active_ms"] > 0 for line in (tmp_path / "observation.jsonl").read_text().splitlines()
                       for epoch in json.loads(line)["epochs"])
        finally:
            release.set()
            thread.join(timeout=3)
            recorder.close()
        assert finished.is_set()
    snapshot = registry.snapshot()["epochs"][0]
    assert snapshot["publish_max_ms"] >= 20 and snapshot["consumer_max_ms"] >= 20
    assert snapshot["symbols"]["EURUSD"]["accepted"] == 1
    assert snapshot["accounting_valid"]
    assert recorder.failure_kind is None and recorder.samples >= 2
