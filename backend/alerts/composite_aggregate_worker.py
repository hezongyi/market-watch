"""Drain durable composite period tasks independently of supplier maintenance.

The existing claim/commit protocol supplies cross-process ownership, bounded
partitions, version ordering and fair oldest-task scheduling. No supplier IO or
live demand is created here. Fast work can continue without the history loop's
network delays and one-second per-partition throttle.
"""

import argparse
import logging
import signal
import threading

from .composite_aggregates import aggregate_tick, runtime_error
from .runtime_health import progress

log = logging.getLogger(__name__)


def run(stopped):
    last_error = None
    while not stopped.is_set():
        try:
            errors = []
            worked = aggregate_tick(on_error=errors.append, runtime_only=True)
            last_error = errors[0] if errors else runtime_error()
        except Exception as error:
            # Preserve the existing bounded local retry for transient DB errors.
            log.error("Composite aggregate scheduler failed: %s", type(error).__name__)
            progress(state="degraded", error=error)
            last_error = type(error).__name__
            stopped.wait(2)
            continue
        progress(state="degraded" if last_error else "running" if worked else "idle",
                 error=last_error)
        stopped.wait(.05 if worked else .5)


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
