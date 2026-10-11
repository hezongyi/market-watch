"""Absolute request deadlines across HTTPcore connection and socket operations."""
import time
from contextlib import contextmanager
from contextvars import ContextVar

import httpcore
import httpx

_DEADLINE = ContextVar("provider_http_deadline", default=None)


def remaining_timeout(timeout, error_type):
    deadline = _DEADLINE.get()
    if deadline is None:
        return timeout
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise error_type("Provider request deadline exhausted")
    return min(timeout, remaining) if timeout is not None else remaining


@contextmanager
def request_deadline(deadline):
    token = _DEADLINE.set(deadline)
    try:
        yield
        if time.monotonic() >= deadline:
            raise httpx.ReadTimeout("Provider request deadline exhausted")
    finally:
        _DEADLINE.reset(token)


class DeadlineStream(httpcore.NetworkStream):
    def __init__(self, stream):
        self.stream = stream

    def read(self, max_bytes, timeout=None):
        return self.stream.read(max_bytes, remaining_timeout(timeout, httpcore.ReadTimeout))

    def write(self, buffer, timeout=None):
        self.stream.write(buffer, remaining_timeout(timeout, httpcore.WriteTimeout))

    def start_tls(self, ssl_context, server_hostname=None, timeout=None):
        return DeadlineStream(self.stream.start_tls(ssl_context, server_hostname,
            remaining_timeout(timeout, httpcore.ConnectTimeout)))

    def close(self):
        self.stream.close()

    def get_extra_info(self, info):
        return self.stream.get_extra_info(info)


class DeadlineBackend(httpcore.NetworkBackend):
    def __init__(self, backend):
        self.backend = backend

    def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        return DeadlineStream(self.backend.connect_tcp(host, port,
            remaining_timeout(timeout, httpcore.ConnectTimeout), local_address, socket_options))

    def connect_unix_socket(self, path, timeout=None, socket_options=None):
        return DeadlineStream(self.backend.connect_unix_socket(path,
            remaining_timeout(timeout, httpcore.ConnectTimeout), socket_options))


def deadline_transport(*, proxy, limits):
    transport = httpx.HTTPTransport(proxy=proxy, limits=limits, trust_env=False)
    # HTTPX 0.28 / HTTPcore 1.0 are pinned in requirements.lock. Wrap the
    # backend before creating connections, preserving TLS and proxy semantics.
    transport._pool._network_backend = DeadlineBackend(transport._pool._network_backend)
    return transport
