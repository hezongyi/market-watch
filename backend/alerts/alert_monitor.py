"""One monitor entry point for production and measured consumers.

Monotonic deadlines control cadence; each alert obtains its own business clock.
Missed turns are coalesced, never overlapped or replayed in a catch-up burst.
"""

import logging
import time

log = logging.getLogger(__name__)


def run(stop, *, period=0.75, monotonic=time.monotonic, on_alert=None, on_turn=None, report_health=None):
    from .chart_alert_worker import step

    if period <= 0:
        raise ValueError('Monitor period must be positive')
    if report_health is None:
        from .chart_alert_health import Heartbeat

        report_health = Heartbeat().record
    deadline = monotonic()
    while not stop.is_set():
        started = monotonic()
        error = None
        chart_done = started
        try:
            step(on_evaluated=on_alert)
            chart_done = monotonic()
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
        try:
            report_health(error)
        except Exception:
            log.exception("Chart alert heartbeat persistence failed")
        if on_turn:
            on_turn(dict(started=started, chart_finished=chart_done, finished=finished,
                         next_deadline=deadline, overrun=overrun, error=error))
        stop.wait(max(0, deadline - monotonic()))
    try:
        report_health(stopped=True)
    except Exception:
        log.exception("Chart alert stopped heartbeat persistence failed")
