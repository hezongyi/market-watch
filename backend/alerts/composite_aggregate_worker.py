"""Drain durable composite period tasks independently of supplier maintenance.

The existing claim/commit protocol supplies cross-process ownership, bounded
partitions, version ordering and fair oldest-task scheduling. No supplier IO or
live demand is created here. Fast work can continue without the history loop's
network delays and one-second per-partition throttle.

A committed composite input publishes a hint, so the next scan starts on that
commit instead of at the end of the poll interval. The hint only moves discovery
earlier: the durable task waterline still decides what work exists, and the
bounded idle poll below remains the fallback whenever no listener is available.
"""

import argparse
import logging
import signal
import threading

from .composite_aggregates import aggregate_tick, runtime_error
from .runtime_health import progress

log = logging.getLogger(__name__)

# Busy yield between slices and the idle floor. Neither is removed by the
# wakeup: a lost LISTEN connection must still find due tasks by polling.
BUSY_YIELD = .05
IDLE_FLOOR = .5


def run(stopped, *, wakeup=None):
    """The listener only shortens idle discovery; error backoff stays a plain wait."""
    from .publication_wakeup import PublicationWakeup

    last_error = None
    listener = wakeup if wakeup is not None else PublicationWakeup()
    with listener:
        while not stopped.is_set():
            # Register (and drain stale hints) before the durable scan: a commit
            # landing during the scan stays queued for wait(), so no wakeup is
            # lost between an empty claim and the sleep that follows it.
            listener.prepare()
            try:
                errors = []
                worked = aggregate_tick(on_error=errors.append, runtime_only=True)
                last_error = errors[0] if errors else runtime_error()
            except Exception as error:
                # Preserve the existing bounded local retry for transient DB errors.
                # A hint cannot cancel this backoff, so a failing database is not
                # retried faster than the durable schedule already allows.
                log.error("Composite aggregate scheduler failed: %s", type(error).__name__)
                progress(state="degraded", error=error)
                last_error = type(error).__name__
                stopped.wait(2)
                continue
            progress(state="degraded" if last_error else "running" if worked else "idle",
                     error=last_error)
            if worked:
                stopped.wait(BUSY_YIELD)
            elif listener.wait(IDLE_FLOOR, stopped) == "notification":
                # Chart, display and this worker's own commits publish on the same
                # channel, so an idle loop can be interrupted for work it does not
                # own. A queued hint returns from wait() without consuming the
                # timeout, so re-listening right after an empty scan would spin at
                # the publication rate. One bounded yield caps an unlucky run at
                # BUSY_YIELD per empty round. A hint for real input still wakes the
                # very next scan and finds its task, and hints arriving during this
                # yield stay queued for prepare(), so none is lost.
                stopped.wait(BUSY_YIELD)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    stopped = threading.Event()
    for name in (signal.SIGINT, signal.SIGTERM):
        signal.signal(name, lambda *_: stopped.set())
    if args.once:
        aggregate_tick()
        return
    run(stopped)


if __name__ == "__main__":
    main()
