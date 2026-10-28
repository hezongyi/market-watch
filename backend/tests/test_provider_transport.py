import httpx
import pytest
from alerts import provider_transport as transport


def test_idle_transport_maintenance_never_fetches_bars_and_yields_to_active_requests(database, monkeypatch):
    clock = [100.0]
    monkeypatch.setattr(transport.time, "monotonic", lambda: clock[0])
    requests = []
    def receive(request):
        requests.append(request)
        assert request.method == "HEAD" and request.url.path == "/"
        assert 'authorization' not in request.headers and not request.url.query
        return httpx.Response(200)
    original_client = httpx.Client
    monkeypatch.setattr(transport.httpx, 'Client', lambda **kwargs:
                        original_client(transport=httpx.MockTransport(receive)))
    transport.close_clients()
    try:
        client = transport.pooled_client('binance')
        assert not transport.maintain('binance', lambda _: False)
        clock[0] += 30
        assert not transport.maintain('binance', lambda _: True), 'foreground work takes priority'
        with transport.activity(client):
            assert not transport.maintain('binance', lambda _: False)
        clock[0] += 30
        assert transport.maintain('binance', lambda _: False)
        assert len(requests) == 2
        assert not transport.maintain('binance', lambda _: False), 'no tight heartbeat retry loop'
    finally:
        transport.close_clients()


def test_transport_maintenance_runs_on_its_supervised_source_loop(monkeypatch):
    import threading

    calls = []
    def maintain(source, _busy):
        calls.append(source)
        stop.set()
    monkeypatch.setattr(transport, "maintain", maintain)
    stop = threading.Event()
    thread = threading.Thread(target=transport.run,
                              args=(stop, lambda _source: False, "binance"))
    thread.start()
    thread.join(1)
    assert not thread.is_alive()
    assert calls == ["binance"]


def test_pool_retains_all_allowed_connections_without_increasing_concurrency(monkeypatch):
    from alerts.market_resources import lane
    calls = []
    original_client = httpx.Client
    def make(**kwargs):
        calls.append(kwargs)
        return original_client(transport=httpx.MockTransport(lambda _: httpx.Response(200)))
    monkeypatch.setattr(transport.httpx, 'Client', make)
    transport.close_clients()
    try:
        assert transport.pooled_client('binance') is transport.pooled_client('binance')
        assert calls[0]['limits'].max_connections == 2
        assert calls[0]['limits'].max_keepalive_connections == 2
        with lane('history'):
            background = transport.pooled_client('binance')
        with lane('realtime'):
            realtime = transport.pooled_client('binance')
        assert len({background, realtime, transport.pooled_client('binance')}) == 3
        assert sum(call['limits'].max_connections for call in calls) == 4, 'lane isolation cannot increase total connections'
        foreground = transport.pooled_client('binance')
        transport.discard_client(background)
        assert transport.pooled_client('binance') is foreground, 'failed background TLS cannot replace a healthy foreground pool'
    finally:
        transport.close_clients()


def test_failed_pool_rotation_preserves_other_active_readers_and_redirects_stale_handles(monkeypatch):
    original_client = httpx.Client
    monkeypatch.setattr(transport.httpx, 'Client', lambda **kwargs:
                        original_client(transport=httpx.MockTransport(lambda _: httpx.Response(200))))
    transport.close_clients()
    try:
        old = transport.pooled_client('binance')
        with transport.activity(old) as active:
            assert active is old
            transport.discard_client(old)
            current = transport.pooled_client('binance')
            assert current is not old and not old.is_closed
            with transport.activity(old) as redirected:
                assert redirected is current, 'a waiter that already obtained the old handle uses the replacement pool'
            transport.discard_client(old)
            assert transport.pooled_client('binance') is current, 'old failures cannot discard a newer pool'
        assert old.is_closed, 'retired pool closes only after all active readers finish'
    finally:
        transport.close_clients()


def test_repeated_real_connect_tunnel_failures_do_not_exhaust_the_running_pool(monkeypatch):
    import socket
    import threading
    import time

    import pytest
    from alerts import provider_chart
    from alerts.config import settings

    proxy = socket.socket()
    proxy.bind(('127.0.0.1', 0))
    proxy.listen()
    proxy.settimeout(0.1)
    stop = threading.Event()
    def accept():
        while not stop.is_set():
            try:
                connection, _ = proxy.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            def tunnel(connection):
                try:
                    connection.recv(8192)
                    connection.sendall(b'HTTP/1.1 200 Connection established\r\n\r\n')
                    stop.wait(1)  # Deliberately never complete the TLS handshake.
                finally:
                    connection.close()
            threading.Thread(target=tunnel, args=(connection,), daemon=True).start()
    server = threading.Thread(target=accept, daemon=True)
    server.start()
    monkeypatch.setattr(settings, 'binance_proxy', 'http://127.0.0.1:' + str(proxy.getsockname()[1]))
    transport.close_clients()
    observed = []
    try:
        for _ in range(5):
            timings = {}
            token = provider_chart.TIMINGS.set(timings)
            try:
                with pytest.raises((TimeoutError, httpx.ConnectTimeout)):
                    provider_chart._request(transport.pooled_client('binance'),
                                            'https://data-api.binance.vision/api/v3/klines',
                                            params={}, deadline=time.monotonic() + 0.05)
                observed.append(timings)
            finally:
                provider_chart.TIMINGS.reset(token)
        assert all('failure_ConnectTimeout' in record for record in observed), (
            'failed CONNECT tunnels cannot consume all four connections and turn the fifth request into PoolTimeout',
            observed,
        )
    finally:
        stop.set()
        proxy.close()
        server.join()
        transport.close_clients()


@pytest.fixture
def persistent_provider_origin(monkeypatch):
    """Real persistent HTTP sockets; concurrent requests must consume distinct connections."""
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    accepted = []
    entered, release = threading.Event(), threading.Event()
    guarded = threading.Lock()
    arrivals = [0]

    class Server(ThreadingHTTPServer):
        daemon_threads = True

        def get_request(self):
            connection, address = super().get_request()
            accepted.append(address[1])
            return connection, address

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_):
            pass

        def do_HEAD(self):
            self.send_response(200)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self):
            if self.path == "/single":
                self.send_response(200)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"{}")
                return
            with guarded:
                arrivals[0] += 1
                if arrivals[0] % 2 == 0:
                    entered.set()
            if not release.wait(3):
                self.send_error(500, "Concurrent caller did not arrive")
                return
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"{}")

    server = Server(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = "http://127.0.0.1:" + str(server.server_port)
    monkeypatch.setitem(transport.ORIGINS, "binance", url)
    monkeypatch.setitem(transport.ORIGINS, "oanda", url)
    from alerts.config import settings
    monkeypatch.setattr(settings, "binance_proxy", "")
    monkeypatch.setattr(settings, "market_proxy", "")
    monkeypatch.setattr(settings, "oanda_proxy", "")
    original_head = httpx.Client.head
    monkeypatch.setattr(httpx.Client, "head", lambda client, *_args, **kwargs:
                        original_head(client, url, **kwargs))
    transport.close_clients()
    try:
        yield url, accepted, entered, release
    finally:
        release.set()
        transport.close_clients()
        server.shutdown()
        server.server_close()
        thread.join()


def overlapping_provider_reads(origin, client):
    import threading
    from concurrent.futures import ThreadPoolExecutor

    url, _, entered, release = origin
    entered.clear()
    release.clear()
    start = threading.Barrier(2)

    def read():
        start.wait(timeout=2)
        with transport.activity(client) as current:
            return current.get(url, timeout=2).status_code

    with ThreadPoolExecutor(max_workers=2) as workers:
        calls = [workers.submit(read) for _ in range(2)]
        try:
            assert entered.wait(2), "Both actual HTTP requests must overlap"
        finally:
            release.set()
        assert [call.result(timeout=3) for call in calls] == [200, 200]


def test_startup_warms_both_chart_connections_before_overlapping_reads(persistent_provider_origin):
    from alerts import provider_chart

    origin = persistent_provider_origin
    provider_chart.warm_clients()
    warmed = len(origin[1])
    overlapping_provider_reads(origin, transport.pooled_client("binance"))
    assert len(origin[1]) == warmed, (
        "A second concurrent chart cannot incur a cold connection after startup warmup",
        warmed, origin[1],
    )


def test_idle_maintenance_keeps_the_second_chart_connection_warm(database, persistent_provider_origin, monkeypatch):
    import time

    from alerts import market_resources

    clock_start, epoch_start = time.monotonic(), market_resources.now_ms()
    origin = persistent_provider_origin
    client = transport.pooled_client("binance")
    overlapping_provider_reads(origin, client)
    opened = len(origin[1])
    for elapsed in (25, 50, 75):
        # Expiry uses HTTPcore's real clock seam; no minute-long test sleeps.
        with monkeypatch.context() as tick:
            import httpcore._sync.http11 as http11
            real_clock = http11.time.monotonic
            tick.setattr(http11.time, "monotonic", lambda: real_clock() + elapsed)
            tick.setattr(market_resources, "now_ms", lambda:
                         epoch_start + int((time.monotonic() - clock_start) * 1000))
            assert transport.maintain("binance", lambda _: False)
    with monkeypatch.context() as tick:
        import httpcore._sync.http11 as http11
        real_clock = http11.time.monotonic
        tick.setattr(http11.time, "monotonic", lambda: real_clock() + 80)
        overlapping_provider_reads(origin, client)
    assert len(origin[1]) == opened, (
        "Idle maintenance must refresh every front-end connection, not just the first",
        opened, origin[1],
    )


def test_one_regular_reader_does_not_let_the_unused_chart_socket_expire(
    database, persistent_provider_origin, monkeypatch,
):
    import time

    from alerts import market_resources

    origin = persistent_provider_origin
    client = transport.pooled_client("binance")
    transport.warm_connections(client, "binance")
    opened = len(origin[1])
    clock_start, epoch_start = time.monotonic(), market_resources.now_ms()
    for elapsed in (15, 30, 45, 60, 75):
        with monkeypatch.context() as tick:
            real_clock = time.monotonic
            tick.setattr(time, "monotonic", lambda: real_clock() + elapsed)
            tick.setattr(market_resources, "now_ms", lambda:
                         epoch_start + int((time.monotonic() - clock_start) * 1000))
            with transport.activity(client) as current:
                assert current.get(origin[0] + "/single").status_code == 200
            transport.maintain("binance", lambda _: False)
    overlapping_provider_reads(origin, client)
    assert len(origin[1]) == opened, "Recent traffic on one connection must not suppress maintenance of the other"


def test_maintenance_releases_held_socket_when_foreground_arrives_during_quota_wait(
    database, persistent_provider_origin, monkeypatch,
):
    import threading

    from alerts import market_resources

    origin = persistent_provider_origin
    client = transport.pooled_client("binance")
    transport.warm_connections(client, "binance")
    opened = len(origin[1])
    with transport._LOCK:
        next(iter(transport._CLIENTS.values()))["last_maintained"] -= 30
    waiting, foreground, done = threading.Event(), threading.Event(), threading.Event()
    acquire = market_resources.acquire

    def reserve(*args):
        token = acquire(*args)
        if token is None:
            waiting.set()
        return token

    monkeypatch.setattr(market_resources, "acquire", reserve)
    result = []

    def maintain():
        try:
            result.append(transport.maintain("binance", lambda _: foreground.is_set()))
        finally:
            done.set()

    worker = threading.Thread(target=maintain)
    worker.start()
    try:
        assert waiting.wait(2), "Maintenance must actually hold one HEAD while waiting for its second quota"
        foreground.set()
        assert done.wait(0.4), "Foreground demand must release the held socket without waiting for background quota"
        assert result == [False]
        overlapping_provider_reads(origin, client)
        assert len(origin[1]) == opened
    finally:
        foreground.set()
        worker.join(timeout=3)
