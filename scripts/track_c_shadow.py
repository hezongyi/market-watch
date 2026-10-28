"""Track C A04a: one Sunday candidate shadow report on an isolated PostgreSQL.

The script builds a synthetic composite through the existing domain operations in
its own schema, prepares the Sunday candidate revision with its period and
indicator artifacts, and records the shadow differences on the switch run. It
never touches an existing composite, run or binding, and it drops its own schema
unless --keep-schema is given.
"""

import argparse
import json
import os
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "backend"), str(ROOT / "backend" / "tests")]

import pytest  # noqa: E402
from alerts import baseline_shadow, storage  # noqa: E402
from sqlalchemy import create_engine, text  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402

STAMP = 200000000


def isolated(url, schema):
    admin = create_engine(url, pool_size=1, max_overflow=0)
    with admin.begin() as connection:
        connection.execute(text('CREATE SCHEMA "' + schema + '"'))
    engine = create_engine(url, connect_args={"options": "-csearch_path=" + schema},
                           pool_size=2, max_overflow=0)
    storage.Base.metadata.create_all(engine)
    return admin, engine


def run(url, schema, *, keep):
    admin, engine = isolated(url, schema)
    factory = sessionmaker(engine, expire_on_commit=False)
    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setattr(storage.settings, "fx_source", "dukascopy")
    monkeypatch.setattr(storage, "Session", factory)
    from alerts import api, provider_chart, provider_service, provider_transport

    monkeypatch.setattr(api, "bootstrap", lambda: None)
    monkeypatch.setattr(provider_chart, "warm_clients", lambda: None)
    monkeypatch.setattr(provider_transport, "start", lambda _: None)
    monkeypatch.setattr(provider_service, "start", lambda _: None)
    monkeypatch.setattr(provider_service, "stop", lambda _: None)
    from test_baseline_shadow import candidate_fixture

    try:
        composite, active, candidate, plan, rules = candidate_fixture(factory, monkeypatch)
        report = baseline_shadow.shadow(composite, scheduled_for=STAMP)
    finally:
        monkeypatch.undo()
        engine.dispose()
        if not keep:
            with admin.begin() as connection:
                connection.execute(text('DROP SCHEMA "' + schema + '" CASCADE'))
        admin.dispose()
    return report


def summary(report):
    return {
        "status": report["status"],
        "ready": report["ready"],
        "reasons": report["reasons"],
        "run": report.get("run"),
        "history_version": report.get("history_version"),
        "revision": report.get("revision"),
        "frames": [{"timeframe": frame["timeframe"], "history": frame["history"].get("status"),
                    "target": frame["target"].get("status"),
                    "same": frame["target"].get("same"), "changed": frame["target"].get("changed"),
                    "added": frame["target"].get("added"),
                    "missing": frame["target"].get("missing"),
                    "max_price_delta": frame["target"].get("max_price_delta")}
                   for frame in report.get("bars", {}).get("frames", [])],
        "gaps": report.get("gaps"),
        "paused_rules": [{"alert_id": rule["alert_id"], "will_pause": rule["will_pause"],
                          "codes": [reason["code"] for reason in rule["reasons"]]}
                         for rule in report.get("paused_rules", [])],
        "bindings": {name: {key: value for key, value in table.items() if key != "digest"}
                     for name, table in report.get("bindings", {}).get("tables", {}).items()},
        "critical_unchanged": report.get("bindings", {}).get("critical_unchanged"),
    }


def main():
    parser = argparse.ArgumentParser(
        description="A04a Sunday candidate shadow report on an isolated PostgreSQL")
    parser.add_argument("--database-url", default=None,
                        help="isolated PostgreSQL URL; defaults to TEST_POSTGRES_URL")
    parser.add_argument("--schema", default=None, help="unique schema; defaults to shadow_<uuid>")
    parser.add_argument("--report", type=Path, default=None, help="write the full report JSON here")
    parser.add_argument("--keep-schema", action="store_true", help="keep the fixture schema")
    args = parser.parse_args()
    url = args.database_url or os.environ.get("TEST_POSTGRES_URL")
    if not url:
        raise SystemExit("需要 --database-url 或隔离实例的 TEST_POSTGRES_URL")
    schema = args.schema or "shadow_" + uuid.uuid4().hex[:12]
    report = run(url, schema, keep=args.keep_schema)
    print(json.dumps({"schema": schema, **summary(report)}, ensure_ascii=False, indent=2))
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    return 0 if report["status"] == "ready" else 1


if __name__ == "__main__":
    raise SystemExit(main())
