"""Verify review fixes on the named Ubuntu API/worker using task-only fixtures."""

import argparse
import json
import time
import uuid
from decimal import Decimal

import httpx
from alerts.storage import Bar, ChartPublication, ChartPublishedBar, Instrument
from chart_alert_acceptance_environment import APP, DATABASE, PROJECT, ROOT
from sqlalchemy import create_engine, select
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker


def wait(check, seconds=60):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        result = check()
        if result:
            return result
        time.sleep(0.3)
    raise AssertionError("Deployed worker did not reach the expected review-fix state")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database-host", required=True)
    args = parser.parse_args()
    if PROJECT != "mw-chart-alerts-integration":
        raise ValueError("Review fixes require the isolated integration project")
    values = dict(line.split("=", 1) for line in (ROOT / "api.env").read_text().splitlines() if "=" in line)
    url = make_url(values["ALERTS_DATABASE_URL"]).set(host=args.database_host)
    if url.database != DATABASE or url.username != DATABASE:
        raise ValueError("Only the task-owned database is allowed")
    engine = create_engine(url)
    factory = sessionmaker(engine, expire_on_commit=False)
    instrument = "ALERTREVIEW_" + uuid.uuid4().hex[:10]
    epoch = int(time.time() * 1000) // 60_000 * 60_000
    observed = int(time.time() * 1000)
    try:
        with factory.begin() as db:
            db.add(Instrument(id=instrument, label="Synthetic review-fix fixture", source="binance",
                              symbol="BTCUSDT", basis="last", calendar="utc0", precision=2))
            db.flush()
            for i in range(3):
                start = epoch - (2 - i) * 60_000
                payload = {"start": start, "end": start + 60_000, "open": "9", "high": "9",
                           "low": "9", "close": "9", "complete": i != 2, "observed_at": observed}
                db.add(Bar(instrument_id=instrument, timeframe="M1", start=start, end=start + 60_000,
                           open=Decimal(9), high=Decimal(9), low=Decimal(9), close=Decimal(9),
                           complete=i != 2, observed_at=observed))
                db.add(ChartPublishedBar(instrument_id=instrument, timeframe="M1", start=start,
                                        end=start + 60_000, complete=i != 2, payload=payload))
            db.add(ChartPublication(instrument_id=instrument, timeframe="M1", start=epoch - 120_000,
                                    end=epoch + 60_000, initialized=True, complete_count=2))
        with httpx.Client(base_url=APP, verify=False, trust_env=False, timeout=10) as client:
            login = client.post("/api/login", json=json.loads((ROOT / "login.json").read_text()))
            login.raise_for_status()
            client.headers["X-CSRF-Token"] = login.json()["csrf"]

            def get(ident):
                response = client.get("/api/chart-alerts/" + ident)
                response.raise_for_status()
                return response.json()

            response = client.post("/api/chart-alerts", json={"request_id": uuid.uuid4().hex,
                "config": {"name": "Published observation race " + instrument, "instrument": instrument,
                           "source": "binance", "timeframe": "M1", "mode": "intrabar", "published": True,
                           "max_triggers": 3, "condition": {"relation": "cross_up",
                                                            "right": {"kind": "constant", "value": "10"}}}})
            response.raise_for_status()
            ident = response.json()["id"]
            wait(lambda: get(ident)["health"] == "ready")
            # Read the durable checkpoint privately. API worker, rather than
            # this script, performs every observation/trigger transition.
            with factory() as db:
                from alerts.storage import ChartAlert
                baseline = db.get(ChartAlert, ident).state["sequence"]
            tick = max(int(time.time() * 1000), baseline + 1)
            with factory.begin() as db:
                stage = db.scalar(select(Bar).where(Bar.instrument_id == instrument, Bar.start == epoch))
                stage.close = stage.high = Decimal(11)
                stage.observed_at = tick
            time.sleep(3)
            with factory() as db:
                assert db.get(ChartAlert, ident).state["sequence"] == baseline
            with factory.begin() as db:
                published = db.get(ChartPublishedBar, (instrument, "M1", epoch))
                published.payload = {**published.payload, "close": "11", "high": "11", "observed_at": tick}
                published.revision += 1
            wait(lambda: get(ident)["count"] == 1)
            row = get(ident)

            def action(intent, expected=200):
                result = client.post("/api/chart-alerts/" + ident + "/lifecycle", json=intent)
                assert result.status_code == expected, f"Lifecycle HTTP {result.status_code}"
                return result.json()

            pause = {"version": row["version"], "control_revision": row["control_revision"],
                     "request_id": uuid.uuid4().hex, "action": "pause"}
            paused = action(pause)
            resumed = action({**pause, "control_revision": paused["control_revision"],
                              "request_id": uuid.uuid4().hex, "action": "resume"})
            action({**pause, "request_id": uuid.uuid4().hex}, expected=409)
            assert action(pause)["status"] == "active"
            restart = {**pause, "control_revision": resumed["control_revision"],
                       "request_id": uuid.uuid4().hex, "action": "restart"}
            restarted = action(restart)
            retried = action(restart)
            assert retried["run"] == restarted["run"] == 2
            assert retried["count"] == restarted["count"] == 0
            action({**restart, "action": "pause"}, expected=409)
            report = {"verified": True, "scope": "actual Ubuntu HTTPS API/autonomous worker/PostgreSQL; synthetic task fixture",
                      "cases": ["staging observation does not advance published price checkpoint",
                                "matching published value/time produces exactly one intrabar crossing",
                                "stale lifecycle revision conflicts; replay cannot undo newer resume",
                                "restart retry preserves one new run; reused identity with changed intent conflicts"],
                      "external_notifications_sent": False}
            (ROOT / "review-fixes-runtime.json").write_text(json.dumps(report, indent=2) + "\n")
            print(json.dumps(report))
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
