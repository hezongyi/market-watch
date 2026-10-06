"""Explicit, transport independent identity and budget."""

import threading
from contextvars import ContextVar
from dataclasses import dataclass, field


@dataclass(frozen=True)
class CallContext:
    agent_id: str
    token_hash: str
    scopes: frozenset[str]
    request_id: str
    deadline: float
    cancelled: threading.Event = field(default_factory=threading.Event)


current_identity: ContextVar[CallContext | None] = ContextVar("agent_identity", default=None)


class CapabilityError(Exception):
    def __init__(self, code, message, retryable=False, context=None):
        super().__init__(message)
        self.code, self.message = code, message
        self.retryable, self.context = retryable, context or {}

    def result(self):
        return {
            "code": self.code,
            "message": self.message,
            "retryable": self.retryable,
            "context": self.context,
        }
