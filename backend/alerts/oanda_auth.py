"""Bounded recovery for refused read-only OANDA requests, without market state."""

import hashlib
import hmac
import json
import logging
import re
import secrets
import time
from random import uniform

log = logging.getLogger(__name__)
_SALT = secrets.token_bytes(32)
_MESSAGES = {
    "Insufficient authorization to perform request.": "insufficient_authorization",
    "The provided request was forbidden.": "forbidden",
}


class AuthRetry:
    """At most three GET attempts within one deadline; never retry a 403."""

    def __init__(self, *, operation, token, account, deadline, cancelled=None):
        self.operation, self.deadline, self.cancelled = operation, deadline, cancelled
        self.identity = hmac.new(_SALT, (token + "\0" + account).encode(), hashlib.sha256).hexdigest()[:16]
        self.secrets = (token, account)
        self.enabled = bool(token.strip() and account.strip())
        self.attempt = 0
        self.refused = False
        self.accepted = False

    def check(self):
        if self.cancelled and self.cancelled():
            raise TimeoutError("OANDA request cancelled")
        if time.monotonic() >= self.deadline:
            raise TimeoutError("OANDA request deadline expired")

    def observe(self, response):
        self.attempt += 1
        status = response.status_code
        self.accepted = status < 400
        if status not in (401, 403) and not self.refused:
            return
        self.refused = self.refused or status in (401, 403)
        request_id = response.headers.get("RequestID", "-")
        if (not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", request_id)
                or any(value and value in request_id for value in self.secrets)):
            request_id = "redacted"
        reason = "unread"
        if response.is_stream_consumed:
            reason = "unrecognized"
            if len(response.content) <= 4096:
                try:
                    payload = json.loads(response.content)
                    if isinstance(payload, dict):
                        reason = _MESSAGES.get(payload.get("errorMessage"), "unrecognized")
                except (ValueError, UnicodeError, TypeError):
                    pass
        outcome = "refused" if status in (401, 403) else "recovered" if status < 400 else "failed"
        log.info("oanda_auth_attempt operation=%s identity=%s attempt=%s http_status=%s "
                 "outcome=%s request_id=%s reason=%s", self.operation, self.identity,
                 self.attempt, status, outcome, request_id, reason)

    def wait(self):
        """Called only after closing the refused response and releasing its slot."""
        if not self.enabled or self.attempt >= 3:
            return False
        self.check()
        delay = 2 ** (self.attempt - 1) * uniform(0.9, 1.1)
        if time.monotonic() + delay >= self.deadline:
            return False
        until = time.monotonic() + delay
        while time.monotonic() < until:
            self.check()
            time.sleep(min(0.1, max(0, until - time.monotonic())))
        self.check()
        return True
