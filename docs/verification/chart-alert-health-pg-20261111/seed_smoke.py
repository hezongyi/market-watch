"""Seed synthetic health states in this task's isolated acceptance database."""

import json
import sys

from alerts.chart_alert_service import create
from alerts.storage import Preference, bootstrap, now_ms, transaction
from argon2 import PasswordHasher
from test_chart_alert_service import config

bootstrap()
password = json.load(sys.stdin)["password"]
stamp = now_ms()
cases = [
    ("active", None, {"execution_state": "monitoring"}),
    ("active", stamp + 3600_000, {"execution_state": "monitoring"}),
    ("active", stamp - 1000, {"execution_state": "closed"}),
    ("expired", stamp - 1000, {"execution_state": "settling", "settlement_pending": True}),
    ("paused", None, {"execution_state": "recovering", "incident": {"id": "smoke"}}),
    ("archived", None, {"execution_state": "closed", "settlement_pending": True}),
    ("paused", None, {"execution_state": "closed"}),
    ("active", None, {}),
]
with transaction() as db:
    credential = db.get(Preference, "auth.admin")
    credential.value = {"hash": PasswordHasher().hash(password)}
    for index, (status, expires_at, runtime) in enumerate(cases):
        row = create(db, f"health-smoke-{index}", config(), at=stamp)
        row.status, row.expires_at, row.runtime = status, expires_at, runtime
print(json.dumps({"synthetic_rules": len(cases), "expected_execution": {
    "monitoring": 2, "settling": 1, "recovering": 1,
}}))
