"""Opt-in, verification-only observation of synchronous HTTPcore network calls.

``with observe_network():`` temporarily installs class wrappers; every worker
thread must opt in separately with ``scoped(observation)``. Streams returned by
TLS negotiation retain their original identity and class. The wrappers forward
all arguments, returned objects and exceptions without changing HTTPcore policy.

For an established HTTPS stream, read metrics describe TLS-decrypted read
returns, including HTTP framing. Plain HTTP and the proxy CONNECT response also
count; SSL's internal handshake receives are not separate observed read calls.
These metrics do not describe kernel TCP arrival or HTTPX's content-decoded
iter_bytes output. TLS metrics describe start_tls itself; for an HTTP CONNECT
proxy that is upstream TLS inside the tunnel. No destination, payload, exception
message or TLS hostname is retained. Use HTTPcore's phase trace to distinguish
CONNECT response bytes from upstream response bytes. In addition, independent
``plaintext_read_*`` and ``tls_read_*`` aggregates classify each current stream
by its underlying SSLSocket or TLSinTLSStream type. This also works when an
already-established pooled TLS connection predates the observation scope.

Snapshots contain bounded aggregates and at most 32 active-call timestamps per
operation. Times ending in ``_at`` are monotonic seconds; durations use ms.
``active_*_wait_ms`` is the longest tracked currently active call, observable
from an independent sampling thread even if the worker has stopped progressing.
"""

import ssl
from contextlib import contextmanager
from functools import wraps
from threading import RLock, local
from time import monotonic

_LOCAL = local()
_PATCH_LOCK = RLock()
_PATCH_USERS = 0
_PATCHED = []
_FAILURE_KINDS = frozenset({
    "ReadTimeout", "ReadError", "ConnectTimeout", "ConnectError", "TimeoutError",
    "OSError", "SSLError", "KeyboardInterrupt", "SystemExit",
})


def _failure_kind(error):
    name = type(error).__name__
    return name if name in _FAILURE_KINDS else "Other"


class NetworkObservation:
    """Thread-safe aggregates without call history or supplier data."""

    def __init__(self, clock=monotonic, max_active=32):
        if not 1 <= max_active <= 32:
            raise ValueError("max_active must be between 1 and 32")
        self._clock = clock
        self._max_active = max_active
        self._lock = RLock()
        self._next_token = 0
        self._operations = {
            name: {"started": 0, "completed": 0, "failures": 0, "active": 0,
                   "active_starts": {}, "active_untracked": 0, "total_ms": 0.0,
                   "max_ms": 0.0, "last_end_at": None, "last_failure": None,
                   "failure_kinds": {kind: 0 for kind in sorted(_FAILURE_KINDS | {"Other"})}}
            for name in ("read", "tls")
        }
        self._read_nonempty = 0
        self._read_empty = 0
        self._read_bytes = 0
        self._last_read_success_at = None
        self._read_paths = {
            name: {"nonempty": 0, "bytes": 0, "failures": 0, "active": 0,
                   "last_success_at": None, "last_failure": None}
            for name in ("plaintext", "tls")
        }

    def _begin(self, operation, read_path=None):
        started_at = self._clock()
        with self._lock:
            metrics = self._operations[operation]
            metrics["started"] += 1
            metrics["active"] += 1
            self._next_token += 1
            token = self._next_token
            if len(metrics["active_starts"]) < self._max_active:
                metrics["active_starts"][token] = (started_at, read_path)
            else:
                token = None
                metrics["active_untracked"] += 1
            if read_path is not None:
                self._read_paths[read_path]["active"] += 1
        return token, started_at

    def _end(self, operation, token, started_at, *, result=None, error=None, read_path=None):
        ended_at = self._clock()
        elapsed_ms = max(0.0, (ended_at - started_at) * 1000)
        with self._lock:
            metrics = self._operations[operation]
            metrics["active"] -= 1
            if token is None:
                metrics["active_untracked"] -= 1
            else:
                metrics["active_starts"].pop(token)
            metrics["total_ms"] += elapsed_ms
            metrics["max_ms"] = max(metrics["max_ms"], elapsed_ms)
            metrics["last_end_at"] = ended_at
            path_metrics = self._read_paths.get(read_path)
            if path_metrics is not None:
                path_metrics["active"] -= 1
            if error is not None:
                kind = _failure_kind(error)
                metrics["failures"] += 1
                metrics["last_failure"] = kind
                metrics["failure_kinds"][kind] += 1
                if path_metrics is not None:
                    path_metrics["failures"] += 1
                    path_metrics["last_failure"] = kind
            else:
                metrics["completed"] += 1
                if operation == "read":
                    # SyncStream's contract is bytes. Avoid inspecting arbitrary
                    # substitute return values so identity/equivalence survives.
                    size = len(result) if isinstance(result, (bytes, bytearray)) else 0
                    if size:
                        self._read_nonempty += 1
                        self._read_bytes += size
                        self._last_read_success_at = ended_at
                        path_metrics["nonempty"] += 1
                        path_metrics["bytes"] += size
                        path_metrics["last_success_at"] = ended_at
                    else:
                        self._read_empty += 1

    def snapshot(self):
        with self._lock:
            now = self._clock()
            snapshot = {"observed_at": now, "read_nonempty": self._read_nonempty,
                        "read_empty": self._read_empty, "read_bytes": self._read_bytes,
                        "last_read_success_at": self._last_read_success_at}
            for operation, metrics in self._operations.items():
                for name in ("started", "completed", "failures", "total_ms", "max_ms"):
                    snapshot[f"{operation}_{name}"] = metrics[name]
                snapshot[f"last_{operation}_end_at"] = metrics["last_end_at"]
                snapshot[f"last_{operation}_failure"] = metrics["last_failure"]
                snapshot[f"{operation}_failure_kinds"] = dict(metrics["failure_kinds"])
                active_name = "active_reads" if operation == "read" else "active_tls"
                snapshot[active_name] = metrics["active"]
                starts = [start for start, _path in metrics["active_starts"].values()]
                snapshot[f"active_{operation}_wait_ms"] = (
                    max(0.0, (now - min(starts)) * 1000) if starts else 0.0)
                snapshot[f"active_{operation}_wait_complete"] = not metrics["active_untracked"]
            for path, metrics in self._read_paths.items():
                for name in ("nonempty", "bytes", "failures"):
                    snapshot[f"{path}_read_{name}"] = metrics[name]
                snapshot[f"active_{path}_reads"] = metrics["active"]
                snapshot[f"last_{path}_read_success_at"] = metrics["last_success_at"]
                snapshot[f"last_{path}_read_failure"] = metrics["last_failure"]
                starts = [start for start, read_path in
                          self._operations["read"]["active_starts"].values() if read_path == path]
                snapshot[f"active_{path}_read_wait_ms"] = (
                    max(0.0, (now - min(starts)) * 1000) if starts else 0.0)
            return snapshot


def _wrapper(original, operation, tls_stream_class):
    @wraps(original)
    def observed(stream, *args, **kwargs):
        observation = getattr(_LOCAL, "observation", None)
        depth_key = f"observing_{operation}"
        previous = getattr(_LOCAL, depth_key, None)
        if observation is None or previous is observation:
            return original(stream, *args, **kwargs)
        read_path = None
        if operation == "read":
            # Existing pooled TLS connections may have completed their handshake
            # outside this scope. Classify the current underlying stream state,
            # independently of trace events, without retaining the object.
            is_tls = (isinstance(stream, tls_stream_class) or
                      isinstance(getattr(stream, "_sock", None), ssl.SSLSocket))
            read_path = "tls" if is_tls else "plaintext"
        _LOCAL.__setattr__(depth_key, observation)
        token, started_at = observation._begin(operation, read_path)
        try:
            result = original(stream, *args, **kwargs)
        except BaseException as error:
            observation._end(operation, token, started_at, error=error, read_path=read_path)
            raise
        else:
            observation._end(operation, token, started_at, result=result, read_path=read_path)
            return result
        finally:
            _LOCAL.__setattr__(depth_key, previous)
    return observed


@contextmanager
def observe_network():
    """Install temporary wrappers, reference counted across nested/thread users."""
    global _PATCH_USERS
    from httpcore._backends import sync

    with _PATCH_LOCK:
        if _PATCH_USERS == 0:
            try:
                for stream_class in (sync.SyncStream, sync.TLSinTLSStream):
                    for method_name, operation in (("read", "read"), ("start_tls", "tls")):
                        original = getattr(stream_class, method_name)
                        wrapper = _wrapper(original, operation, sync.TLSinTLSStream)
                        setattr(stream_class, method_name, wrapper)
                        _PATCHED.append((stream_class, method_name, original))
            except BaseException:
                for stream_class, method_name, original in reversed(_PATCHED):
                    setattr(stream_class, method_name, original)
                _PATCHED.clear()
                raise
        _PATCH_USERS += 1
    try:
        yield
    finally:
        with _PATCH_LOCK:
            _PATCH_USERS -= 1
            if _PATCH_USERS == 0:
                for stream_class, method_name, original in reversed(_PATCHED):
                    setattr(stream_class, method_name, original)
                _PATCHED.clear()


@contextmanager
def scoped(observation):
    """Attribute only this thread's calls to an observation; restore nested scope."""
    previous = getattr(_LOCAL, "observation", None)
    _LOCAL.observation = observation
    try:
        yield observation
    finally:
        _LOCAL.observation = previous
