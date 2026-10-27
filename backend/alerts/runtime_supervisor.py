"""Small lifecycle supervisor for service-owned background loops."""

import logging
import signal
import threading
import time
from collections.abc import Callable
from contextlib import contextmanager, nullcontext
from dataclasses import dataclass

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Loop:
    role: str
    run: Callable[[threading.Event], None]


class RuntimeGroupError(RuntimeError):
    def __init__(self, failures, alive=()):
        self.failures = failures
        self.alive = tuple(alive)
        details = [f"{role}: {type(error).__name__}" for role, error in failures.items()]
        details.extend(f"{role}: did not stop" for role in self.alive)
        super().__init__("Runtime group failed: " + "; ".join(details))


def run_steps(step, stop, *, idle_wait, work_wait=.01, on_cycle=None):
    """Run a simple bounded step loop; complex loops keep their own run(stop)."""
    if idle_wait <= 0 or work_wait <= 0:
        raise ValueError("Loop waits must be positive")
    while not stop.is_set():
        started = time.monotonic()
        result = step()
        finished = time.monotonic()
        if on_cycle:
            try:
                on_cycle(result=result, started=started, finished=finished)
            except Exception as error:
                log.warning("Loop progress report failed error_type=%s", type(error).__name__)
        stop.wait(work_wait if result else idle_wait)


@contextmanager
def signal_stops(stop, signals=(signal.SIGINT, signal.SIGTERM)):
    """Temporarily translate process termination signals into the shared stop."""
    if threading.current_thread() is not threading.main_thread():
        raise RuntimeError("Signal handlers must be installed by the main thread")
    previous = {signum: signal.getsignal(signum) for signum in signals}
    try:
        for signum in signals:
            signal.signal(signum, lambda *_: stop.set())
        yield
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)


def run_group(loops, *, stop=None, on_state=None, join_timeout=30, handle_signals=True):
    """Run critical loops together and fail the process if one fails or won't stop."""
    loops = tuple(loops)
    if not loops or len({loop.role for loop in loops}) != len(loops):
        raise ValueError("Runtime group requires uniquely named loops")
    if join_timeout <= 0:
        raise ValueError("Join timeout must be positive")
    stop = stop or threading.Event()
    if stop.is_set():
        return
    failures = {}
    lock = threading.Lock()

    def report(role, state, error=None):
        if on_state:
            try:
                on_state(role, state, error)
            except Exception as error:
                log.warning("Loop state report failed role=%s error_type=%s",
                            role, type(error).__name__)

    def invoke(loop):
        report(loop.role, "running")
        try:
            loop.run(stop)
        except BaseException as error:
            with lock:
                failures[loop.role] = error
            stop.set()
            report(loop.role, "failed", type(error).__name__)
            return
        if stop.is_set():
            report(loop.role, "stopped")
            return
        error = RuntimeError("Critical loop returned unexpectedly")
        with lock:
            failures[loop.role] = error
        stop.set()
        report(loop.role, "failed", type(error).__name__)

    threads = [threading.Thread(target=invoke, args=(loop,), name=loop.role)
               for loop in loops]
    handler_scope = signal_stops(stop) if handle_signals else nullcontext()
    with handler_scope:
        for thread in threads:
            thread.start()
        while any(thread.is_alive() for thread in threads) and not stop.wait(.05):
            pass
        stop.set()
        for thread in threads:
            thread.join(join_timeout)

    alive = [loop.role for loop, thread in zip(loops, threads) if thread.is_alive()]
    if failures or alive:
        raise RuntimeGroupError(failures, alive)
