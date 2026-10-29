"""One monitor entry point for production and measured consumers.

Monotonic deadlines control cadence; each alert obtains its own business clock.
Missed turns are coalesced, never overlapped or replayed in a catch-up burst.
Committed publications can interrupt healthy idle waits; errors and overruns
retain their bounded cadence waits.
"""

import logging
import time

from .runtime_health import RuntimeOwnershipLost, progress

log = logging.getLogger(__name__)


def run(stop, *, period=0.25, monotonic=time.monotonic, on_alert=None, on_turn=None,
        report_health=None, wakeup=None):
    from .chart_alert_worker import step
    from .publication_wakeup import PublicationWakeup

    if period <= 0:
        raise ValueError('Monitor period must be positive')
    if report_health is None:
        from .chart_alert_health import Heartbeat

        report_health = Heartbeat().record
    deadline = monotonic()
    listener = wakeup if wakeup is not None else PublicationWakeup(monotonic=monotonic)
    with listener:
        while not stop.is_set():
            # Hint draining must precede the scan: hints of commits made during
            # the scan stay queued, closing the empty-scan-to-sleep race.
            listener.prepare()
            started = monotonic()
            error = None
            evaluated = 0
            chart_done = started
            try:
                errors = []
                evaluated = step(on_evaluated=on_alert,
                                 on_error=lambda value: errors.append(value) if not errors else None) or 0
                error = errors[0] if errors else None
                chart_done = monotonic()
            except RuntimeOwnershipLost:
                raise
            except Exception as exc:
                error = type(exc).__name__
                log.exception('Chart alert monitor iteration failed')
            finished = monotonic()
            progress(state="degraded" if error else "idle", error=error)
            deadline += period
            overrun = finished >= deadline
            if error:
                deadline = finished + period
            elif overrun:
                # No immediate retries after an error; overloaded rounds get one
                # full future deadline rather than a zero-wait processing loop.
                deadline += (int(max(0, finished - deadline) / period) + 1) * period
            # A wakeup can start turns well ahead of the fixed cadence; cap the
            # next start at one period from here so a later idle wait is never
            # stretched by the burst that preceded it.
            deadline = min(deadline, finished + period)
            try:
                report_health(error)
            except Exception:
                log.exception("Chart alert heartbeat persistence failed")
            if on_turn:
                on_turn(dict(started=started, chart_finished=chart_done, finished=finished,
                             next_deadline=deadline, overrun=overrun, error=error))
            # Publications cannot cancel an error backoff or the future turn
            # selected after an overrun. A partly successful scan can still
            # report a rule error, so evaluated_count is not a backoff gate.
            if error or overrun:
                stop.wait(max(0, deadline - monotonic()))
                continue
            reason = listener.wait(max(0, deadline - monotonic()), stop)
            # No rule reached a judgment this turn: nothing is active, or every
            # active rule sits in the retired branch. No verdict is waiting, so
            # the period stays the only start signal.
            # Trade-off: the sleep is a plain bounded one because a queued
            # hint makes the listener's notifies() return without consuming
            # its timeout, so re-waiting on hints here would spin a core
            # until the deadline. Input that advances inside this window is
            # handled at most one period (<= .25 s) later; prepare() drains
            # the hints before the next scan, so no wakeup is lost.
            if evaluated == 0 and reason == 'notification':
                stop.wait(max(0, deadline - monotonic()))
    try:
        report_health(stopped=True)
    except Exception:
        log.exception("Chart alert stopped heartbeat persistence failed")
