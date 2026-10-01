import httpx
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
        assert len(requests) == 1
        assert not transport.maintain('binance', lambda _: False), 'no tight heartbeat retry loop'
    finally:
        transport.close_clients()


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
                with pytest.raises(TimeoutError):
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
