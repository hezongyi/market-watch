"""Destructive fixture-only drill for this task's isolated PostgreSQL database.

Requires private ALERTS_DATABASE_URL / MW_DRILL_DIR / MW_EVIDENCE_PATH.
Refuses existing verification data. Never runs against the mobile acceptance DB.
The imported fixture clock does not alter the host/database clock.
"""

import json
import os
import pathlib

from alerts import retention_window as window
from alerts import storage
from alerts.config import settings
from alerts.storage import Base, Preference, SourceMinute
from sqlalchemy import create_engine, select
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker
from test_managed_retention import graph
from test_retention_window import DAY, LOWER, NOW, OLD, counts, run

url = make_url(settings.database_url)
assert url.host == "127.0.0.1" and url.port == 25476 and url.database == "rollover_test"
engine = create_engine(settings.database_url)
Base.metadata.create_all(engine)
factory = sessionmaker(engine, expire_on_commit=False)
storage.Session = factory
settings.managed_rollover_enabled = True
with factory() as db:
    assert db.get(storage.MarketComposite, "comp") is None, (
        "Do not overwrite prior verification data"
    )
graph(factory, starts=(OLD - 120000, OLD - 60000, OLD, LOWER, LOWER + DAY // 2))
run_id = run(factory)
before = counts(factory)
dry = window.tick(dry_run=True, now=NOW)
assert dry["report"]["deleted"] == window._zero_deleted()
assert counts(factory) == before
blocked = window.tick(dry_run=False, now=NOW)
assert blocked["report"]["skipped"][0]["reason"] == "restore_drill_missing"
assert counts(factory) == before
marker = window.restore_drill(pathlib.Path(os.environ["MW_DRILL_DIR"]))
assert marker["backend"] == "postgresql"
original = window._checkpoint


def killed(*args, **kwargs):
    raise KeyboardInterrupt("simulated process termination after committed chunk")


window._checkpoint = killed
try:
    try:
        window.tick(dry_run=False, now=NOW, chunk=1)
    except KeyboardInterrupt:
        pass
    else:
        raise AssertionError("Interruption did not occur")
finally:
    window._checkpoint = original
with factory() as db:
    batch = db.scalar(
        select(Preference).where(
            Preference.key.startswith(window.DAILY_PREFIX),
            Preference.value["mode"].as_string() == "execute",
        )
    ).value
    assert batch["retention"]["stats"]["deleted"]["market_source_minutes"] == 1
resume = window.tick(dry_run=False, now=NOW, chunk=1)
assert resume["report"]["batch"]["stats"]["deleted"]["market_source_minutes"] == 3
with factory() as db:
    assert list(db.scalars(select(SourceMinute.start).order_by(SourceMinute.start))) == [
        LOWER,
        LOWER + DAY // 2,
    ]
assert not window.tick(dry_run=False, now=NOW)["unlocked"]
next_day = window.tick(dry_run=False, now=NOW + DAY, chunk=1)
assert next_day["report"]["batch"]["stats"]["deleted"]["market_source_minutes"] == 2
with factory() as db:
    assert not list(db.scalars(select(SourceMinute)))
result = {
    "fixture_clock": NOW,
    "host_clock_unchanged": True,
    "database": "task-owned rollover_test/public",
    "restore": {
        k: marker[k] for k in ("sha256", "verified_at", "tables", "backend", "bytes", "schema")
    },
    "before": before,
    "dry_run": dry,
    "missing_restore_gate": blocked,
    "resumed": resume,
    "next_day": next_day,
    "after": counts(factory),
}
pathlib.Path(os.environ["MW_EVIDENCE_PATH"]).write_text(json.dumps(result, indent=2) + "\n")
print(
    json.dumps(
        {
            "passed": True,
            "actual_postgres_backup_restore": True,
            "interrupted_batch_deleted": 3,
            "next_day_deleted_without_new_switch": 2,
        }
    )
)
