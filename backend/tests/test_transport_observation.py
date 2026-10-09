"""Synthetic local transport probes; no supplier/account/network credentials."""

import importlib.util
import ipaddress
import socketserver
import ssl
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpcore
import httpx
import pytest
from httpcore._backends import sync

MODULE_PATH = (Path(__file__).resolve().parents[2] / "docs" / "verification" /
               "oanda-stream-isolated" / "transport_observation.py")
spec = importlib.util.spec_from_file_location("transport_observation", MODULE_PATH)
observation_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observation_module)
NetworkObservation = observation_module.NetworkObservation
observe_network = observation_module.observe_network
scoped = observation_module.scoped


def test_read_forwards_arguments_return_and_exception_identity(monkeypatch):
    timestamp = [10.0]
    result = b"private-payload"
    failure = httpcore.ReadTimeout("private-exception-message")
    calls = []
    observation = NetworkObservation(clock=lambda: timestamp[0])

    def original(stream, *args, **kwargs):
        calls.append((stream, args, kwargs))
        timestamp[0] += 0.1
        waiting = observation.snapshot()
        assert waiting["active_reads"] == 1
        assert waiting["active_read_wait_ms"] == pytest.approx(100)
        timestamp[0] += 0.15
        if len(calls) == 2:
            raise failure
        return result

    monkeypatch.setattr(sync.SyncStream, "read", original)
    stream = sync.SyncStream(None)
    with observe_network(), scoped(observation):
        assert stream.read(17, timeout=1.2) is result
        with pytest.raises(httpcore.ReadTimeout) as caught:
            stream.read(max_bytes=29, timeout=0.5)
        assert caught.value is failure
    assert sync.SyncStream.read is original
    assert calls == [(stream, (17,), {"timeout": 1.2}),
                     (stream, (), {"max_bytes": 29, "timeout": 0.5})]
    snapshot = observation.snapshot()
    assert snapshot["read_started"] == 2
    assert snapshot["read_completed"] == 1
    assert snapshot["read_failures"] == 1
    assert snapshot["read_nonempty"] == 1
    assert snapshot["read_bytes"] == len(result)
    assert snapshot["read_max_ms"] == pytest.approx(250)
    assert snapshot["active_reads"] == 0
    assert snapshot["last_read_success_at"] == pytest.approx(10.25)
    assert snapshot["last_read_failure"] == "ReadTimeout"
    assert "private" not in repr(snapshot)


def test_empty_read_is_completion_but_not_successful_data(monkeypatch):
    monkeypatch.setattr(sync.SyncStream, "read", lambda *_args, **_kwargs: b"")
    observation = NetworkObservation()
    with observe_network(), scoped(observation):
        assert sync.SyncStream(None).read(1) == b""
    snapshot = observation.snapshot()
    assert snapshot["read_completed"] == snapshot["read_empty"] == 1
    assert snapshot["read_nonempty"] == snapshot["read_bytes"] == 0
    assert snapshot["last_read_success_at"] is None


@pytest.mark.parametrize("failure", [False, True])
def test_tls_preserves_forwarding_identity_and_counts_separately(monkeypatch, failure):
    timestamp = [20.0]
    returned = sync.SyncStream(None)
    error = httpcore.ConnectTimeout("private-tls-message")
    context = object()
    calls = []
    observation = NetworkObservation(clock=lambda: timestamp[0])

    def original(stream, *args, **kwargs):
        calls.append((stream, args, kwargs))
        timestamp[0] += 0.2
        assert observation.snapshot()["active_tls_wait_ms"] == pytest.approx(200)
        if failure:
            raise error
        return returned

    monkeypatch.setattr(sync.SyncStream, "start_tls", original)
    monkeypatch.setattr(sync.SyncStream, "read", lambda *_args, **_kwargs: b"decoded")
    stream = sync.SyncStream(None)
    with observe_network(), scoped(observation):
        if failure:
            with pytest.raises(httpcore.ConnectTimeout) as caught:
                stream.start_tls(context, server_hostname="private-host", timeout=0.8)
            assert caught.value is error
        else:
            result = stream.start_tls(context, server_hostname="private-host", timeout=0.8)
            assert result is returned
            assert result.read(7) == b"decoded"
    assert sync.SyncStream.start_tls is original
    assert calls == [(stream, (context,), {"server_hostname": "private-host", "timeout": 0.8})]
    snapshot = observation.snapshot()
    assert snapshot["tls_started"] == 1
    assert snapshot["tls_completed"] == int(not failure)
    assert snapshot["tls_failures"] == int(failure)
    assert snapshot["tls_max_ms"] == pytest.approx(200)
    assert snapshot["active_tls"] == 0
    assert snapshot["read_nonempty"] == int(not failure)
    assert "private" not in repr(snapshot)


def test_scope_is_threadlocal_nested_and_wrappers_restore_on_exit(monkeypatch):
    def original(*_args, **_kwargs):
        return b"x"

    monkeypatch.setattr(sync.SyncStream, "read", original)
    outer = NetworkObservation()
    inner = NetworkObservation()
    other = NetworkObservation()
    stream = sync.SyncStream(None)

    def background():
        stream.read(1)  # No scope: this thread must not inherit the outer scope.
        with scoped(other):
            stream.read(1)

    with pytest.raises(ValueError, match="intentional"):
        with observe_network(), scoped(outer):
            installed = sync.SyncStream.read
            with observe_network(), scoped(inner):
                stream.read(1)
            assert sync.SyncStream.read is installed
            stream.read(1)
            thread = threading.Thread(target=background)
            thread.start()
            thread.join(timeout=2)
            assert not thread.is_alive()
            raise ValueError("intentional")
    assert sync.SyncStream.read is original
    assert outer.snapshot()["read_nonempty"] == 1
    assert inner.snapshot()["read_nonempty"] == 1
    assert other.snapshot()["read_nonempty"] == 1


def test_nested_stream_implementations_are_counted_once(monkeypatch):
    monkeypatch.setattr(sync.SyncStream, "read", lambda *_args, **_kwargs: b"decrypted")
    monkeypatch.setattr(sync.TLSinTLSStream, "read",
                        lambda *_args, **_kwargs: sync.SyncStream(None).read(9))
    monkeypatch.setattr(sync.SyncStream, "start_tls", lambda *_args, **_kwargs: "same-result")
    monkeypatch.setattr(sync.TLSinTLSStream, "start_tls",
                        lambda *_args, **_kwargs: sync.SyncStream(None).start_tls(None))
    nested = object.__new__(sync.TLSinTLSStream)
    observation = NetworkObservation()
    with observe_network(), scoped(observation):
        assert nested.read(9, timeout=0.2) == b"decrypted"
        assert nested.start_tls(None, timeout=0.2) == "same-result"
    snapshot = observation.snapshot()
    assert snapshot["read_started"] == snapshot["read_nonempty"] == 1
    assert snapshot["tls_started"] == snapshot["tls_completed"] == 1


@contextmanager
def local_response(mode, tls_context=None):
    received_request = threading.Event()
    release = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            received_request.set()
            if mode == "headers":
                release.wait(timeout=2)
                return
            self.send_response(200)
            self.send_header("Content-Length", "1000")
            self.end_headers()
            if mode == "partial":
                # Transport and content chunks advance; no complete NDJSON line.
                for part in [b'{"type":', b'"HEART', b'BEAT"']:
                    try:
                        self.wfile.write(part)
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):
                        return
                    time.sleep(0.01)
            release.wait(timeout=2)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    if tls_context is not None:
        server.socket = tls_context.wrap_socket(server.socket, server_side=True)
    serving = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01})
    serving.start()
    try:
        scheme = "http" if tls_context is None else "https"
        yield f"{scheme}://127.0.0.1:{server.server_port}/", received_request
    finally:
        release.set()
        server.shutdown()
        serving.join(timeout=2)
        server.server_close()


@pytest.mark.parametrize("mode", ["headers", "body", "partial"])
def test_real_httpx_header_body_and_partial_stalls_have_distinct_data(mode):
    observation = NetworkObservation()
    chunks = []
    response_headers_seen = False
    with local_response(mode) as (url, received_request):
        with httpx.Client(timeout=httpx.Timeout(0.06, connect=1), trust_env=False) as client:
            with observe_network(), scoped(observation):
                with pytest.raises(httpx.ReadTimeout):
                    with client.stream("GET", url) as response:
                        response_headers_seen = True
                        chunks.extend(response.iter_bytes())
            assert received_request.is_set()
    snapshot = observation.snapshot()
    assert snapshot["read_failures"] == 1
    assert snapshot["last_read_failure"] == "ReadTimeout"
    assert snapshot["active_reads"] == 0
    assert snapshot["read_max_ms"] >= 40
    assert snapshot["tls_started"] == 0
    if mode == "headers":
        assert not response_headers_seen
        assert snapshot["read_nonempty"] == snapshot["read_bytes"] == 0
        assert snapshot["last_read_success_at"] is None
    else:
        assert response_headers_seen
        assert snapshot["read_nonempty"] > 0
        assert snapshot["read_bytes"] > 0
        assert snapshot["last_read_success_at"] is not None
    if mode == "partial":
        assert b"".join(chunks) == b'{"type":"HEARTBEAT"'
        assert b"\n" not in b"".join(chunks)
    else:
        assert chunks == []


def test_snapshot_reports_wait_from_an_independent_observer(monkeypatch):
    started = threading.Event()
    release = threading.Event()
    observation = NetworkObservation()

    def original(*_args, **_kwargs):
        started.set()
        assert release.wait(timeout=2)
        return b"late"

    monkeypatch.setattr(sync.SyncStream, "read", original)

    def worker():
        with scoped(observation):
            sync.SyncStream(None).read(4, timeout=1)

    with observe_network():
        thread = threading.Thread(target=worker)
        thread.start()
        try:
            assert started.wait(timeout=1)
            snapshot = observation.snapshot()
            assert snapshot["active_reads"] == 1
            assert snapshot["active_read_wait_ms"] >= 0
            assert snapshot["read_completed"] == 0
            assert snapshot["read_nonempty"] == 0
        finally:
            release.set()
            thread.join(timeout=2)
    assert observation.snapshot()["read_nonempty"] == 1


def test_real_connect_tunnel_tls_stall_is_tls_not_http_response_wait():
    """The `proxy.start_tls` trace means upstream TLS inside CONNECT."""
    release = threading.Event()
    tls_started = threading.Event()
    phases = []
    observation = NetworkObservation()

    class Handler(socketserver.BaseRequestHandler):
        def handle(self):
            self.request.settimeout(1)
            headers = b""
            while b"\r\n\r\n" not in headers:
                headers += self.request.recv(4096)
                assert len(headers) < 8192
            assert headers.startswith(b"CONNECT ")
            self.request.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
            assert self.request.recv(4096)  # TLS ClientHello, never persisted.
            tls_started.set()
            release.wait(timeout=2)

    server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01})
    thread.start()
    try:
        proxy = f"http://127.0.0.1:{server.server_address[1]}"
        with httpx.Client(proxy=proxy, timeout=httpx.Timeout(0.06), trust_env=False) as client:
            with observe_network(), scoped(observation):
                with pytest.raises(httpx.ConnectTimeout):
                    client.get("https://upstream.invalid/", extensions={
                        "trace": lambda name, _info: phases.append(name)})
        assert tls_started.is_set()
    finally:
        release.set()
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()
    snapshot = observation.snapshot()
    assert snapshot["tls_started"] == snapshot["tls_failures"] == 1
    assert snapshot["tls_completed"] == 0
    assert snapshot["last_tls_failure"] == "ConnectTimeout"
    assert snapshot["tls_max_ms"] >= 40
    assert snapshot["read_failures"] == 0
    assert snapshot["read_nonempty"] >= 1  # CONNECT response, not origin response.
    assert snapshot["plaintext_read_nonempty"] >= 1
    assert snapshot["tls_read_nonempty"] == snapshot["tls_read_bytes"] == 0
    assert "proxy.start_tls.failed" in phases
    assert "http11.receive_response_headers.complete" in phases


def test_real_tls_read_is_decrypted_and_separate_from_plaintext(tmp_path):
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    # Generated only in pytest's temporary directory, never a stored key fixture.
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
    now = datetime.now(timezone.utc)
    certificate = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject)
                   .public_key(private_key.public_key()).serial_number(x509.random_serial_number())
                   .not_valid_before(now - timedelta(minutes=1))
                   .not_valid_after(now + timedelta(minutes=5))
                   .add_extension(x509.SubjectAlternativeName([
                       x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]),
                       critical=False)
                   .sign(private_key, hashes.SHA256()))
    key_path = tmp_path / "synthetic-tls.key"
    cert_path = tmp_path / "synthetic-tls.crt"
    key_path.write_bytes(private_key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption()))
    key_path.chmod(0o600)
    cert_path.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server_context.load_cert_chain(cert_path, key_path)
    trusted_context = ssl.create_default_context(cafile=cert_path)
    observation = NetworkObservation()
    chunks = []
    with local_response("partial", tls_context=server_context) as (url, _):
        with httpx.Client(verify=trusted_context, trust_env=False,
                          timeout=httpx.Timeout(0.06, connect=1)) as client:
            with observe_network(), scoped(observation):
                with pytest.raises(httpx.ReadTimeout):
                    with client.stream("GET", url) as response:
                        chunks.extend(response.iter_bytes())
    snapshot = observation.snapshot()
    assert b"".join(chunks) == b'{"type":"HEARTBEAT"'
    assert snapshot["tls_started"] == snapshot["tls_completed"] == 1
    assert snapshot["tls_failures"] == 0
    assert snapshot["tls_read_nonempty"] == snapshot["read_nonempty"] > 0
    assert snapshot["tls_read_bytes"] == snapshot["read_bytes"] > len(b"".join(chunks))
    assert snapshot["plaintext_read_nonempty"] == snapshot["plaintext_read_bytes"] == 0
    assert snapshot["last_tls_read_success_at"] == snapshot["last_read_success_at"]
    assert snapshot["tls_read_failures"] == 1
    assert snapshot["last_tls_read_failure"] == "ReadTimeout"
