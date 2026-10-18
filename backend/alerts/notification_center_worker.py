"""Independent replayable projection worker; health does not depend on its projection."""
import argparse
import logging
import time

from .config import settings
from .notification_center import backfill, project, rebuild, reconcile_channels, retain
from .storage import Preference, now_ms, transaction

log = logging.getLogger(__name__)


def once():
    if not settings.notification_center_projection_enabled:
        return 0
    with transaction() as db:
        count = project(db)
        if count < 100:
            count += backfill(db, limit=100-count)
        if count == 0:
            count += reconcile_channels(db)
        return count


def report(state, count=0, error=None):
    with transaction() as db:
        row = db.get(Preference, 'notice_projector_health')
        value = {'at': now_ms(), 'state': state, 'batch_count': count,
                 'error_type': type(error).__name__ if error else None}
        if row:
            row.value = value
        else:
            db.add(Preference(key='notice_projector_health', value=value))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--once', action='store_true')
    parser.add_argument('--rebuild', action='store_true', help='Replay retained notice sources; never re-evaluate or deliver')
    args = parser.parse_args()
    if args.rebuild:
        with transaction() as db:
            rebuild(db)
        while once():
            pass
        report('ok')
        return
    last_report, last_retention = 0, 0
    while True:
        try:
            count = once()
            if now_ms() - last_report > 30_000:
                report('ok' if settings.notification_center_projection_enabled else 'paused', count)
                last_report = now_ms()
            if now_ms() - last_retention > 60_000:
                with transaction() as db:
                    retain(db)
                last_retention = now_ms()
        except Exception as error:
            count = 0
            log.exception('Notice projection unavailable')
            try:
                report('failed', error=error)
            except Exception:
                log.warning('Notice worker health unavailable')
            if args.once:
                raise
        if args.once:
            return
        time.sleep(0.02 if count else 2)


if __name__ == '__main__':
    main()
