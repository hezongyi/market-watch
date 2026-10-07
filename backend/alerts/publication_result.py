"""Progress facts consumed by publication scheduling, independent of readers."""

from dataclasses import dataclass


@dataclass(frozen=True)
class PublicationResult:
    snapshot_changed: bool = False
    task_progressed: bool = False
    runnable_remaining: bool = False
    next_due_at: int | None = None
    blocked_reason: str | None = None
    selected_target: tuple[str, str] | None = None
    attempted: bool = False

    def __bool__(self):
        # Existing callers may use truthiness, but inspecting a target is never
        # progress. Waiting/retry facts cannot select the worker's busy delay.
        return self.snapshot_changed or self.task_progressed or self.runnable_remaining
