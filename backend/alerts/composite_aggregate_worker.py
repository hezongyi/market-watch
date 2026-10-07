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

from .composite_aggregates import aggregate_tick

log = logging.getLogger(__name__)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    stopped = threading.Event()
    for name in (signal.SIGINT, signal.SIGTERM):
        signal.signal(name, lambda *_: stopped.set())
    while not stopped.is_set():
        try:
            worked = aggregate_tick()
        except Exception as error:
            # Never print database URLs, statements or supplier credentials.
            log.error("Composite aggregate scheduler failed: %s", type(error).__name__)
            if args.once:
                raise
            stopped.wait(2)
            continue
        if args.once:
            return
        stopped.wait(.05 if worked else .5)


if __name__ == "__main__":
    main()
