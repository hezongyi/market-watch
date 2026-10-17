"""Exercise #74's additive migration only on its named restored acceptance DB."""

import hashlib
import json

from alembic import command
from alembic.config import Config
from alerts.config import settings
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import make_url

url = make_url(settings.database_url)
if url.host != "pg" or url.database != "indicator_parity" or settings.database_application_name != "mw-issue74-20261017":
    raise RuntimeError("Requires the isolated #74 acceptance configuration")
settings.database_url = url.set(database="indicator_parity_restore").render_as_string(hide_password=False)
engine = create_engine(settings.database_url)


def fingerprint():
    with engine.connect() as db:
        counts = {table: db.scalar(text(f"SELECT count(*) FROM {table}")) for table in (
            "chart_published_bars", "market_fixed_indicator_runs", "market_fixed_indicator_blocks", "market_history_versions")}
        blocks = list(db.execute(text("SELECT run_id, start, checksum FROM market_fixed_indicator_blocks ORDER BY run_id,start")))
        runs = list(db.execute(text("SELECT id, state FROM market_fixed_indicator_runs ORDER BY id")))
        digest = hashlib.sha256(json.dumps([list(map(tuple, blocks)), list(map(tuple, runs))], sort_keys=True).encode()).hexdigest()
    return dict(counts=counts, immutable_digest=digest)


baseline = fingerprint()
report = {"host": "Ubuntu local Docker", "database": "indicator_parity_restore", "baseline": baseline, "steps": []}
config = Config("alembic.ini")
for action, revision, table_expected in (("upgrade", "head", True), ("downgrade", "au48_display_indicator_tasks", False), ("upgrade", "head", True)):
    getattr(command, action)(config, revision)
    state = fingerprint()
    assert state == baseline, "Existing publication, results or checkpoints changed"
    assert inspect(engine).has_table("market_indicator_demands") == table_expected
    assert inspect(engine).has_table("market_indicator_schedule") == table_expected
    report["steps"].append(dict(action=action, revision=revision, preserved=True, demand_tables=table_expected))
print(json.dumps(report, indent=2))
