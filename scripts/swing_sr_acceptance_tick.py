"""Change only the final candle of the task's isolated frozen fixture."""

import json
import sys
from pathlib import Path

from alerts.config import settings
from alerts.storage import ChartPublication, ChartPublishedBar, transaction
from sqlalchemy import func, select
from sqlalchemy.engine import make_url

url = make_url(settings.database_url)
assert url.host == "postgres" and url.database == "swing" and url.username == "swing"
assert settings.database_application_name == "mw-swing-sr-20261012"
assert not settings.delivery_enabled and not settings.oanda_token
action = sys.argv[1]
assert action in ("withdraw", "restore", "confirm")
rows = [json.loads(line) for line in
        Path("/acceptance/evidence/snapshot.jsonl").read_text().splitlines()]
original = next(row for row in reversed(rows) if row["kind"] == "managed_bar")
payload = dict(original)
if action == "withdraw":
    payload["high"] = "1.12500"
if action == "confirm":
    payload["complete"] = True
with transaction() as db:
    assert db.scalar(select(func.count()).select_from(ChartPublishedBar)) == 4002
    publication = db.get(ChartPublication, ("EURUSD", "H4"))
    assert publication and publication.end == original["end"]
    candle = db.get(ChartPublishedBar, ("EURUSD", "H4", original["start"]))
    assert candle is not None
    publication.complete_count += int(payload["complete"]) - int(candle.complete)
    candle.payload, candle.complete = payload, payload["complete"]
    candle.revision += 1
    publication.revision += 1
print(f"Isolated Swing fixture final candle: {action}")
