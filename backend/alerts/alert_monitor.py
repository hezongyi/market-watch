"""One monitor entry point for production and measured consumers.

Monotonic deadlines control cadence; each alert obtains its own business clock.
Missed turns are coalesced, never overlapped or replayed in a catch-up burst.
"""

import logging
import time

log = logging.getLogger(__name__)


def run(stop, *, period=1.0, monotonic=time.monotonic, on_alert=None, on_turn=None):
    from .chart_alert_worker import step
    from .composite_watches import step as watch_step

    if period <= 0:
        raise ValueError('Monitor period must be positive')
    deadline = monotonic()
    while not stop.is_set():
        started = monotonic()
        error = None
        chart_done = started
        try:
            step(on_evaluated=on_alert)
            chart_done = monotonic()
            watch_step()
        except Exception as exc:
            error = type(exc).__name__
            log.exception('Chart alert monitor iteration failed')
        finished = monotonic()
        deadline += period
        overrun = finished >= deadline
        if error:
            deadline = finished + period
        elif overrun:
            # No immediate retries after an error; overloaded rounds get one
            # full future deadline rather than a zero-wait processing loop.
            deadline += (int(max(0, finished - deadline) / period) + 1) * period
        if on_turn:
            on_turn(dict(started=started, chart_finished=chart_done, finished=finished,
                         next_deadline=deadline, overrun=overrun, error=error))
        stop.wait(max(0, deadline - monotonic()))
