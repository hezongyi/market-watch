"""Fault injection against deployed task API/worker, using synthetic task-only DB rows.

A generated close-rule epoch is moved back while its worker is stopped to model
an existing run with pending data. Evaluation always runs in the container.
"""

import argparse
import json
import shlex
import subprocess
import time
import uuid
from decimal import Decimal

import httpx
from alerts.storage import Bar, ChartAlert, Instrument
from chart_alert_acceptance_environment import APP, COMPOSE, DATABASE, PROJECT, ROOT
from sqlalchemy import create_engine, select
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker


def compose(*args):
    return subprocess.run(
        [
            "sg",
            "docker",
            "-c",
            shlex.join(
                [
                    "docker",
                    "compose",
                    "--env-file",
                    str(ROOT / "compose.env"),
                    "-p",
                    PROJECT,
                    "-f",
                    str(COMPOSE),
                    *args,
                ]
            ),
        ],
        check=True,
        capture_output=True,
        timeout=60,
    )


def wait(check, description, seconds=60):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        try:
            result = check()
            if result:
                return result
        except httpx.HTTPError:
            pass
        time.sleep(0.3)
    raise AssertionError(description)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database-host", required=True)
    args = parser.parse_args()
    values = dict(
        line.split("=", 1) for line in (ROOT / "api.env").read_text().splitlines() if "=" in line
    )
    url = make_url(values["ALERTS_DATABASE_URL"]).set(host=args.database_host)
    if url.database != DATABASE or url.username != DATABASE:
        raise ValueError("Only task-owned database allowed")
    engine = create_engine(url)
    factory = sessionmaker(engine, expire_on_commit=False)
    instrument = "ALERTFAULT_" + uuid.uuid4().hex[:10]
    epoch = int(time.time() * 1000) // 60_000 * 60_000 - 10 * 60_000
    report = {
        "scope": "deployed autonomous worker; synthetic data, gaps, stale timestamps and generated rule epoch",
        "cases": [],
    }
    stopped = False

    def bar(db, start, price, complete=True, observed=None):
        db.add(
            Bar(
                instrument_id=instrument,
                timeframe="M1",
                start=start,
                end=start + 60_000,
                open=Decimal(price),
                high=Decimal(price),
                low=Decimal(price),
                close=Decimal(price),
                complete=complete,
                observed_at=observed or int(time.time() * 1000),
            )
        )

    with factory.begin() as db:
        db.add(
            Instrument(
                id=instrument,
                label="Task-owned synthetic fault fixture",
                source="binance",
                symbol="BTCUSDT",
                basis="last",
                calendar="utc0",
                precision=2,
            )
        )
        db.flush()
        for i in range(80):
            bar(db, epoch - (80 - i) * 60_000, 9)
    try:
        with httpx.Client(base_url=APP, verify=False, trust_env=False, timeout=5) as client:

            def login():
                r = client.post("/api/login", json=json.loads((ROOT / "login.json").read_text()))
                r.raise_for_status()
                client.headers["X-CSRF-Token"] = client.get("/api/session").json()["csrf"]
                return True

            login()

            def post(path, body):
                r = client.post("/api" + path, json=body)
                r.raise_for_status()
                return r.json()

            def get(path):
                r = client.get("/api" + path)
                r.raise_for_status()
                return r.json()

            def create(mode):
                return post(
                    "/chart-alerts",
                    {
                        "request_id": uuid.uuid4().hex,
                        "config": {
                            "name": "Task fault " + instrument + " " + mode,
                            "instrument": instrument,
                            "source": "binance",
                            "timeframe": "M1",
                            "mode": mode,
                            "max_triggers": 3,
                            "condition": {
                                "relation": "cross_up",
                                "right": {"kind": "constant", "value": "10"},
                            },
                        },
                    },
                )

            row = create("close")
            ident = row["id"]

            def state():
                return get("/chart-alerts/" + ident)

            wait(lambda: state()["health"] == "stale", "old complete source must be stale")
            with factory() as db:
                assert db.get(ChartAlert, ident).state["sequence"] == epoch
            compose("stop", "api")
            stopped = True
            with factory.begin() as db:
                # Explicit fault fixture: generated rule simulates a run active at epoch.
                db.get(ChartAlert, ident).effective_at = epoch
                bar(db, epoch + 60_000, 9)
                bar(db, epoch + 120_000, 11)
            compose("start", "api")
            stopped = False
            wait(login, "HTTPS login after restart")
            wait(
                lambda: state()["health"] == "stale", "missing first pending bar blocks advancement"
            )
            time.sleep(2)
            with factory() as db:
                assert db.get(ChartAlert, ident).state["sequence"] == epoch
            assert get("/chart-alerts/events?alert_id=" + ident) == []
            with factory.begin() as db:
                bar(db, epoch, 11)
            wait(lambda: state()["count"] == 2, "backfill must release pending bars in order")
            events = get("/chart-alerts/events?alert_id=" + ident)
            assert len(events) == 2 and all(e["evidence"]["late"] for e in events)
            report["cases"].append(
                "gap fences persisted checkpoint; actual backfill yields exactly two ordered late events"
            )
            compose("stop", "api")
            stopped = True
            with factory.begin() as db:
                bar(db, epoch + 180_000, 9)
                bar(db, epoch + 240_000, 11)
            compose("start", "api")
            stopped = False
            wait(login, "HTTPS login after queued data restart")
            wait(
                lambda: state()["count"] == 3 and state()["status"] == "completed",
                "restart consumes pending data",
            )
            time.sleep(2)
            events = get("/chart-alerts/events?alert_id=" + ident)
            assert len(events) == 3 and len({e["id"] for e in events}) == 3
            assert [e["evidence"]["ordinal"] for e in reversed(events)] == [1, 2, 3]
            report["cases"].append(
                "container restart consumes queued bars once, preserves prior two events and completes at three"
            )
            current = int(time.time() * 1000) // 60_000 * 60_000
            with factory.begin() as db:
                bar(db, current, 9, complete=False, observed=int(time.time() * 1000) - 180_001)
            live = create("intrabar")
            wait(
                lambda: get("/chart-alerts/" + live["id"])["health"] == "stale",
                "stale live source is visible",
            )
            assert get("/chart-alerts/" + live["id"])["count"] == 0
            with factory.begin() as db:
                value = db.scalar(
                    select(Bar).where(Bar.instrument_id == instrument, Bar.start == current)
                )
                value.observed_at = int(time.time() * 1000)
            wait(
                lambda: get("/chart-alerts/" + live["id"])["health"] == "ready",
                "fresh observations recover monitoring",
            )
            assert get("/chart-alerts/" + live["id"])["count"] == 0
            report["cases"].append(
                "stale intrabar observation is rejected; fresh source restores ready baseline without firing"
            )
            report.update(verified=True, close_alert=ident, intrabar_alert=live["id"])
            (ROOT / "fault-acceptance.json").write_text(json.dumps(report, indent=2) + "\n")
            print(json.dumps(report))
    finally:
        if stopped:
            compose("start", "api")
        engine.dispose()


if __name__ == "__main__":
    main()
