"""Exercise the running isolated API/worker with explicitly synthetic database inputs.

No in-process API or worker calls. This is separate from real-source acquisition
and native-chart checks. Only the named task database and generated fixture IDs
are allowed. Credentials and detailed evidence stay under the private /tmp dir.
"""

import argparse
import json
import time
import uuid
from decimal import Decimal

import httpx
from alerts.storage import Bar, ChartAlert, Instrument, Outbox
from chart_alert_acceptance_environment import APP, DATABASE, ROOT
from sqlalchemy import create_engine, select
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database-host", required=True)
    args = parser.parse_args()
    values = dict(
        line.split("=", 1) for line in (ROOT / "api.env").read_text().splitlines() if "=" in line
    )
    url = make_url(values["ALERTS_DATABASE_URL"])
    if url.database != DATABASE or url.username != DATABASE:
        raise ValueError("Only the dedicated chart-alert acceptance database is allowed")
    engine = create_engine(url.set(host=args.database_host))
    factory = sessionmaker(engine, expire_on_commit=False)
    report = {
        "scope": "running Ubuntu Compose API/worker/PostgreSQL; synthetic fixture observations",
        "cases": [],
        "external_notifications_sent": False,
    }
    ident = "ALERTFIX_" + uuid.uuid4().hex[:10]
    current = int(time.time() * 1000) // 60_000 * 60_000
    with factory.begin() as db:
        db.add(
            Instrument(
                id=ident,
                label="Isolated synthetic alert acceptance",
                source="binance",
                symbol="BTCUSDT",
                basis="last",
                calendar="utc0",
                precision=2,
            )
        )
        db.flush()
        for i in range(80):
            start = current - (79 - i) * 60_000
            db.add(
                Bar(
                    instrument_id=ident,
                    timeframe="M1",
                    start=start,
                    end=start + 60_000,
                    open=Decimal(9),
                    high=Decimal(9),
                    low=Decimal(9),
                    close=Decimal(9),
                    complete=i < 79,
                    observed_at=int(time.time() * 1000),
                )
            )

    def wait(check, description, seconds=20):
        until = time.monotonic() + seconds
        while time.monotonic() < until:
            result = check()
            if result:
                return result
            time.sleep(0.25)
        raise AssertionError("Timed out: " + description)

    try:
        with httpx.Client(base_url=APP, verify=False, timeout=40, trust_env=False) as client:
            r = client.post("/api/login", json=json.loads((ROOT / "login.json").read_text()))
            r.raise_for_status()
            csrf = client.get("/api/session").json()["csrf"]
            client.headers["X-CSRF-Token"] = csrf

            def post(path, body):
                response = client.post("/api" + path, json=body)
                response.raise_for_status()
                return response.json()

            def get(path):
                response = client.get("/api" + path)
                response.raise_for_status()
                return response.json()

            def create(maximum, **changes):
                config = {
                    "name": "Runtime " + ident + " " + str(maximum),
                    "instrument": ident,
                    "source": "binance",
                    "timeframe": "M1",
                    "mode": "intrabar",
                    "max_triggers": maximum,
                    "condition": {
                        "relation": "cross_up",
                        "left": {"kind": "price"},
                        "right": {"kind": "constant", "value": "10"},
                    },
                    **changes,
                }
                return post("/chart-alerts", {"request_id": uuid.uuid4().hex, "config": config})

            rows = [create(maximum) for maximum in (1, 2, 3)]
            notified = create(3, notify_ntfy=True)
            ids = [r["id"] for r in rows] + [notified["id"]]

            def state(ident):
                return get("/chart-alerts/" + ident)

            wait(lambda: all(state(i)["health"] == "ready" for i in ids), "autonomous baseline")
            assert all(state(i)["count"] == 0 for i in ids)
            report["cases"].append("running autonomous worker initializes baseline without firing")

            def tick(price, active):
                stamp = int(time.time() * 1000)
                with factory.begin() as db:
                    live = db.scalar(
                        select(Bar).where(Bar.instrument_id == ident, Bar.start == current)
                    )
                    live.open = live.high = live.low = live.close = Decimal(price)
                    live.observed_at = stamp

                def observed():
                    with factory() as db:
                        return all(
                            (
                                db.get(ChartAlert, i).state.get("sequence", -1) >= stamp
                                or db.get(ChartAlert, i).status == "completed"
                            )
                            for i in active
                        )

                wait(observed, "worker consumes sample")

            for price in [11, 11, 10, 11, 9, 11]:
                tick(price, ids)
            for maximum, row in zip((1, 2, 3), rows):
                saved = state(row["id"])
                assert saved["count"] == maximum and saved["status"] == "completed"
                events = get("/chart-alerts/events?alert_id=" + row["id"])
                assert len(events) == maximum
                assert sorted(e["evidence"]["ordinal"] for e in events) == list(
                    range(1, maximum + 1)
                )
            assert state(notified["id"])["count"] == 3
            report["cases"].append(
                "1/2/3 triggers stop at limit; sustained/equal/released same-candle observations obey counts"
            )
            notes = get("/chart-alerts/events?alert_id=" + notified["id"])
            wait(
                lambda: all(
                    e["delivery_status"] == "accepted"
                    for e in get("/chart-alerts/events?alert_id=" + notified["id"])
                ),
                "isolated notification service retry and acceptance",
                seconds=55,
            )
            with factory() as db:
                attempts = list(
                    db.scalars(
                        select(Outbox.attempts).where(
                            Outbox.notification_id.in_([e["notification_id"] for e in notes])
                        )
                    )
                )
            assert max(attempts) >= 2, (
                "Reset only the task notification-sink before retry acceptance"
            )
            report["notification_delivery_attempts"] = sorted(attempts)
            post("/notifications/" + notes[0]["notification_id"] + "/ack", {})
            saved_notes = get("/chart-alerts/events?alert_id=" + notified["id"])
            assert sum(e["notification_status"] == "acknowledged" for e in saved_notes) == 1
            assert state(notified["id"])["count"] == 3
            report["cases"].append(
                "isolated notification sink accepts events after retry; acknowledging one leaves other events independent"
            )
            report["notification_alert"] = notified["id"]
            report["finite_alerts"] = ids
            interval = create(
                2,
                condition={
                    "relation": "enter",
                    "left": {"kind": "price"},
                    "lower": "10",
                    "upper": "12",
                },
            )
            wait(lambda: state(interval["id"])["health"] == "ready", "interval baseline")
            for price in [14, 11, 11, 9, 14, 11]:
                tick(price, [interval["id"]])
            assert state(interval["id"])["count"] == 2
            report["cases"].append(
                "price interval skips unobserved jump across range; counts only actual entries"
            )
            revised = create(
                3,
                condition={
                    "relation": "cross_up",
                    "left": {
                        "kind": "indicator",
                        "indicator": {"name": "EMA", "params": {"period": 3}, "output": "value"},
                    },
                    "right": {"kind": "constant", "value": "100"},
                },
            )
            wait(lambda: state(revised["id"])["health"] == "ready", "indicator baseline")
            with factory.begin() as db:
                old = db.scalar(
                    select(Bar).where(Bar.instrument_id == ident, Bar.start == current - 60_000)
                )
                old.open = old.high = old.low = old.close = Decimal(8)
            wait(lambda: state(revised["id"])["health"] == "blocked", "historical revision fencing")
            saved = state(revised["id"])
            rebuilt = post(
                "/chart-alerts/" + saved["id"] + "/lifecycle",
                {"version": saved["version"], "control_revision": saved["control_revision"],
                 "request_id": uuid.uuid4().hex, "action": "rebaseline"},
            )
            assert rebuilt["count"] == saved["count"] and rebuilt["run"] == saved["run"]
            wait(
                lambda: state(revised["id"])["health"] == "ready", "explicit historical rebaseline"
            )
            assert get("/chart-alerts/events?alert_id=" + revised["id"]) == []
            report["cases"].append(
                "real persisted history revision blocks indicator evaluation; explicit rebaseline preserves run/count without duplicate events"
            )
            for row in (interval, revised):
                report.setdefault("additional_alerts", []).append(row["id"])
            (ROOT / "runtime-api-worker.json").write_text(
                json.dumps(report, ensure_ascii=False, indent=2) + "\n"
            )
            print(
                json.dumps(
                    {"passed": report["cases"], "evidence": str(ROOT / "runtime-api-worker.json")},
                    ensure_ascii=False,
                )
            )
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
