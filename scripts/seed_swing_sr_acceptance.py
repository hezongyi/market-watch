"""Insert frozen OANDA evidence into this task's empty PostgreSQL database only."""

import json
import sys
from pathlib import Path

from alerts.calendar_profile import normalized_profile
from alerts.config import settings
from alerts.storage import (
    ChartHistoryPlan,
    ChartPublication,
    ChartPublishedBar,
    Instrument,
    transaction,
)
from sqlalchemy import func, select
from sqlalchemy.engine import make_url

url = make_url(settings.database_url)
assert url.host == "postgres" and url.database == "swing" and url.username == "swing"
assert settings.database_application_name == "mw-swing-sr-20261012"
assert not settings.delivery_enabled and not settings.oanda_token
evidence = Path("/acceptance/evidence")


def records(name):
    return map(json.loads, (evidence / name).read_text().splitlines())


native = [r["payload"] for r in records("long_snapshot.jsonl") if r["kind"] == "provider_bar"]
tail = [r for r in records("snapshot.jsonl") if r["kind"] == "managed_bar"]
rows = native + [r for r in tail if r["start"] > native[-1]["start"]]
assert len(rows) == 4002
profile = normalized_profile(json.loads((evidence / "swing-acceptance-calendar.json").read_text()))
if sys.argv[1:] == ["--calendar-only"]:
    with transaction() as db:
        assert db.scalar(select(func.count()).select_from(ChartPublishedBar)) == 4002
        publication = db.get(ChartPublication, ("EURUSD", "H4"))
        assert publication and publication.start == rows[0]["start"] and publication.end == rows[-1]["end"]
        db.get(Instrument, "EURUSD").calendar_profile = profile
        publication.revision += 1
    print("Configured the explicit holiday policy for this frozen acceptance fixture only.")
    raise SystemExit(0)
assert not sys.argv[1:]
with transaction() as db:
    assert db.scalar(select(func.count()).select_from(ChartPublishedBar)) == 0, (
        "Seed only an empty task DB"
    )
    inst = db.get(Instrument, "EURUSD")
    assert inst is not None
    inst.source, inst.symbol, inst.basis = "oanda", "EUR_USD", "bid"
    inst.calendar, inst.precision, inst.enabled = "ny17", 5, False
    inst.calendar_profile = profile
    db.add(
        ChartHistoryPlan(
            instrument_id=inst.id,
            target_start=rows[0]["start"],
            target_end=rows[-1]["end"],
            cursor=rows[-1]["end"],
            status="complete",
            realtime_enabled=False,
        )
    )
    db.add(
        ChartPublication(
            instrument_id=inst.id,
            timeframe="H4",
            start=rows[0]["start"],
            end=rows[-1]["end"],
            complete_count=sum(r["complete"] for r in rows),
            initialized=True,
            revision=1,
        )
    )
    for row in rows:
        db.add(
            ChartPublishedBar(
                instrument_id=inst.id,
                timeframe="H4",
                start=row["start"],
                end=row["end"],
                complete=row["complete"],
                payload=row,
            )
        )
print("Seeded 4002 frozen OANDA EURUSD bid H4 candles into the isolated swing database.")
