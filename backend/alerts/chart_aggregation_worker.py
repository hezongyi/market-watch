"""Independent bounded CPU work; no provider requests or notification delivery."""
import logging
import time

from .chart_aggregation import aggregate_once
from .managed_dataset import publish_once


def main():
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    while True:
        started = time.monotonic()
        try:
            worked = aggregate_once()
            published = publish_once()
            if worked:
                logging.info('chart_aggregation_slice seconds=%.3f', time.monotonic()-started)
            time.sleep(0.1 if worked or published else 1)
        except Exception as error:
            logging.warning('chart_aggregation_cycle_failed type=%s', type(error).__name__)
            time.sleep(5)


if __name__ == '__main__':
    main()
