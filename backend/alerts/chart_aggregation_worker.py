"""Independent bounded CPU work; no provider requests or notification delivery."""
import logging
import time

from .chart_aggregation import aggregate_once
from .managed_dataset import publish_once
from .publication_budget import work_budget


def cycle():
    # Service publication first, then only start aggregation if its complete
    # bucket fits the remaining shared budget. Each transaction commits alone.
    with work_budget() as budget:
        published = publish_once()
        budget.reserve_slice()
        worked = aggregate_once()
    return worked, published


def wait_seconds(worked, published):
    # One bounded target per turn: ninety ready periods can rotate without the
    # former nine-second sleep floor. Idle queue checks average one SQL/second.
    if worked or published:
        return 0.02
    due = getattr(published, 'next_due_at', None)
    if due is not None:
        from .storage import now_ms
        return min(2, max(.02, (due - now_ms()) / 1000))
    return 2


def main():
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    while True:
        started = time.monotonic()
        try:
            worked, published = cycle()
            if worked:
                logging.info('chart_aggregation_slice seconds=%.3f', time.monotonic()-started)
            time.sleep(wait_seconds(worked, published))
        except Exception as error:
            logging.warning('chart_aggregation_cycle_failed type=%s', type(error).__name__)
            time.sleep(5)


if __name__ == '__main__':
    main()
