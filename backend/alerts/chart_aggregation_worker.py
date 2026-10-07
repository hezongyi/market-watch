"""Independent bounded CPU work; no provider requests or notification delivery."""
import logging
import time

from .chart_aggregation import aggregate_once
from .managed_dataset import publish_once
from .publication_budget import work_budget


def cycle(*, observer=None):
    # Service publication first, then only start aggregation if its complete
    # bucket fits the remaining shared budget. Each transaction commits alone.
    with work_budget() as budget:
        publication_started = time.monotonic() if observer is not None else None
        published = publish_once()
        publication_finished = time.monotonic() if observer is not None else None
        budget.reserve_slice()
        aggregation_started = time.monotonic() if observer is not None else None
        worked = aggregate_once()
        aggregation_finished = time.monotonic() if observer is not None else None
    if observer is not None:
        # Call boundaries include selection and transaction work; they are not
        # target-selection or commit timestamps. Observe after both calls so
        # optional measurement cannot consume their shared work budget.
        observer(dict(publication_started=publication_started,
                      publication_finished=publication_finished,
                      publication_result=published,
                      aggregation_started=aggregation_started,
                      aggregation_finished=aggregation_finished,
                      aggregation_result=worked))
    return worked, published


def wait_seconds(worked, published):
    # Drain a confirmed ready publication queue promptly. Progress alone does
    # not prove another target is ready. Idle checks average one SQL/second.
    if getattr(published, 'runnable_remaining', False):
        return 0.005
    if worked or published:
        return 0.02
    due = getattr(published, 'next_due_at', None)
    if due is not None:
        from .storage import now_ms
        return min(2, max(.02, (due - now_ms()) / 1000))
    return 2


def main():
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    from .publication_wakeup import PublicationWakeup
    with PublicationWakeup() as wakeup:
        while True:
            wakeup.prepare()
            started = time.monotonic()
            try:
                worked, published = cycle()
                if worked:
                    logging.info('chart_aggregation_slice seconds=%.3f', time.monotonic()-started)
                wakeup.wait(wait_seconds(worked, published))
            except Exception as error:
                logging.warning('chart_aggregation_cycle_failed type=%s', type(error).__name__)
                time.sleep(5)


if __name__ == '__main__':
    main()
