"""Bounded retries of complete transactions, never of a failed Session."""

import time

from sqlalchemy.exc import DBAPIError


def is_conflict(error):
    return isinstance(error, DBAPIError) and getattr(error.orig, "sqlstate", None) in (
        "40P01", "40001"
    )


def retry_conflicts(operation):
    # operation owns its Session/transaction context. Its exception must unwind
    # (rollback + close) before the next attempt observes lease, cursor or state.
    for attempt in range(3):
        try:
            return operation()
        except DBAPIError as error:
            if not is_conflict(error) or attempt == 2:
                raise
            time.sleep(0.01 * 2 ** attempt)
