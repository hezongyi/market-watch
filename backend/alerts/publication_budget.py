"""Shared cooperative limits between atomic, restartable worker slices.

The deadline is checked between queries, not a promise to preempt an in-flight
SQL statement. Source limits include complete target buckets, never half bars.
"""

import time
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field

_CURRENT = ContextVar('publication_budget', default=None)


@dataclass
class Budget:
    rows: int = 4096
    deadline: float = field(default_factory=lambda: time.monotonic() + .075)
    started: bool = False
    history_served: bool = False
    aggregation_served: bool = False

    @property
    def available(self):
        # Allow one minimal slice even if metadata/lock checks consumed the
        # deadline. Otherwise expensive selection could make no work forever.
        available = self.rows if self.aggregation_served else max(0, self.rows - 1500)
        return available if not self.started or time.monotonic() < self.deadline else 0

    def reserve_slice(self):
        # One complete source aggregate has a guaranteed turn, even if the
        # preceding publication exhausted the cooperative time deadline.
        if not self.aggregation_served:
            self.aggregation_served = True
            self.started = False

    def consume(self, rows, *, progressed=True):
        self.started |= progressed
        self.rows -= rows


def current():
    return _CURRENT.get()


@contextmanager
def work_budget():
    if current() is not None:
        yield current()
        return
    token = _CURRENT.set(Budget())
    try:
        yield current()
    finally:
        _CURRENT.reset(token)
