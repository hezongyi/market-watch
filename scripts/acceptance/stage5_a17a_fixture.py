"""Stage-5 A17a fixture and observation helper (container-only).

Reuses the stage-2 synthetic OANDA wire fixture and baseline seeder, but seeds
the migrated public schema so the API, the three runtime groups and the fixture
share one database. Every OANDA destination is rewritten to the task-local
fixture-supplier container inside this process, so no real market provider is
contacted. Nothing here creates, patches or skips delivery.
"""

import argparse
import json
import os
import re
import time
from pathlib import Path
from urllib.parse import urlparse

ARTIFACTS = Path("/artifacts")
ACCOUNT = "composite-test-account"
RUN = os.environ.get("MW_A17A_RUN", "")


def write(name, value):
    (ARTIFACTS / name).write_text(json.dumps(value, ensure_ascii=False, indent=2))


def control_path():
    return ARTIFACTS / "a17a-control.json"


def clock(control):
    """Business time shared by every fixture process.

    The baseline seeder stamps data far in the past, so a per-process monotonic
    clock would disagree between the market runtime and the notification health
    loop. A single offset from the real clock keeps every group honest while
    staying inside the fixture's own time base.
    """
    offset = control.get("offset_ms")
    if offset is None:
        return control["business_origin"] + int(
            (time.monotonic() - control["monotonic_origin"]) * 1000)
    return int(time.time() * 1000) - offset


def configure(control):
    """Give this process the fixture time base before any business code runs."""
    from datetime import datetime

    import runtime_market_network_acceptance as net
    from alerts import storage
    from alerts.config import settings

    class FixtureDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls.fromtimestamp(clock(control) / 1000, tz)

    storage.datetime = FixtureDatetime
    settings.oanda_calendar_version = control["calendar_version"]
    net.clock = clock


TASK_DATABASES = r"^(runtime_stage5|runtime_stage5_a17a_r2)$"


def task_database():
    return os.environ.get("MW_A17A_DB", "runtime_stage5")


def guard():
    parsed = urlparse(os.environ.get("ALERTS_DATABASE_URL", ""))
    if (not re.fullmatch(r"[a-z][a-z0-9_]{0,20}", RUN)
            or parsed.hostname != "postgres"
            or parsed.path != "/" + task_database()
            or not re.fullmatch(TASK_DATABASES, task_database())
            or parsed.query
            or os.environ.get("ALERTS_RUNTIME_DEPLOYMENT") != "stage5_a17a"):
        raise RuntimeError("Only the isolated stage-5 A17a task database is allowed")


def seed(control):
    from sqlalchemy import delete

    import runtime_market_baseline as baseline
    from alerts import storage
    from alerts.config import settings
    from alerts.live_pricing import account_key
    from alerts.realtime_switch import set_enabled
    from alerts.storage import (
        CompositeRevision,
        Instrument,
        MarketComposite,
        MarketDataset,
        MarketDemand,
        Preference,
        PricingOwner,
        ProviderInterest,
        RealtimeMapping,
    )

    engine, factory, patch, ids, composite, revision, seam, stamp, target, inventory = (
        baseline.seed("public", "normal"))
    storage.bootstrap(engine)
    with factory.begin() as db:
        db.execute(delete(ProviderInterest).where(ProviderInterest.id == "baseline-foreground"))
        for name in ("BTCUSDT", "ETHUSDT", "EURUSD", "XAUUSD"):
            if db.get(Instrument, name):
                set_enabled(db, name, False, now=stamp)
        owner = db.get(PricingOwner, account_key(ACCOUNT))
        owner.token, owner.expires, owner.next_at, owner.error = None, 0, 0, None
        db.merge(Preference(key="a17a_fixture", value={"run": RUN, "synthetic": True}))
        if settings.oanda_acquisition_mode == "rest_batch":
            composite_row = db.get(MarketComposite, composite)
            revision_row = db.get(CompositeRevision, revision)
            target_row = db.get(RealtimeMapping, revision_row.mapping_id)
            set_enabled(
                db, db.get(MarketDataset, target_row.target_dataset_id).instrument_id, True, now=stamp)
            db.add(MarketDemand(
                id="a17a-" + RUN, instrument_id=composite_row.instrument_id,
                composite_revision_id=revision, expires=stamp + 3600000))
    control.update({
        "run": RUN, "schema": "public", "business_origin": stamp,
        "monotonic_origin": time.monotonic(), "rules": ids,
        "rule_modes": inventory["rule_modes"], "composite": composite,
        "revision": revision, "target": target, "seam": seam,
        "calendar_version": settings.oanda_calendar_version,
        "offset_ms": int(time.time() * 1000) - stamp, "synthetic": True,
    })
    write("a17a-control.json", control)
    engine.dispose()
    patch.undo()
    print(json.dumps({"seeded": RUN, "rules": len(ids), "schema": "public", "synthetic": True}),
          flush=True)


def state(label):
    from sqlalchemy import select

    from alerts import runtime_health
    from alerts.storage import (
        DeliveryAttempt,
        Notification,
        Outbox,
        Preference,
        Session,
        SignalRow,
        now_ms,
    )

    stamp = now_ms()
    with Session() as db:
        roles = []
        for group, names in (("market", runtime_health.MARKET_ROLES),
                             ("data", runtime_health.data_roles()),
                             ("notifications", runtime_health.NOTIFICATION_ROLES)):
            for row in runtime_health.summary(db, names, at=stamp):
                checked = row.get("checked_at")
                roles.append({
                    "group": group, "role": row.get("role"), "state": row.get("state"),
                    "error_type": row.get("error_type"), "boot_id": row.get("boot_id"),
                    "checked_age_ms": None if checked is None else stamp - checked,
                    "stale_after_ms": row.get("stale_after_ms"),
                })
        notes = [{
            "id": row.id, "kind": row.kind, "status": row.status, "created_at": row.created_at,
            "title": (row.payload or {}).get("title"),
            "message": (row.payload or {}).get("message"),
        } for row in db.scalars(select(Notification).order_by(Notification.created_at, Notification.id))]
        outbox = [{
            "id": row.id, "notification_id": row.notification_id, "status": row.status,
            "attempts": row.attempts, "provider_id": row.provider_id, "error": row.error,
            "next_at": row.next_at,
        } for row in db.scalars(select(Outbox).order_by(Outbox.id))]
        attempts = [{
            "notification_id": row.notification_id, "status": row.status,
            "details": row.details, "at": row.at,
        } for row in db.scalars(select(DeliveryAttempt).order_by(DeliveryAttempt.at))]
        signals = [{
            "id": row.id, "rule": row.chart_alert_id, "occurred_at": row.occurred_at,
            "price": None if row.price is None else str(row.price),
        } for row in db.scalars(select(SignalRow).order_by(SignalRow.id))]
        incidents = [{
            "key": row.key, "state": (row.value or {}).get("state"),
            "category": (row.value or {}).get("category"),
            "last_notified_at": (row.value or {}).get("last_notified_at"),
        } for row in db.scalars(select(Preference).where(
            Preference.key.like("runtime_incident:%")).order_by(Preference.key))]
    value = {
        "label": label, "at": stamp, "business_at": None if not control_path().exists()
        else clock(json.loads(control_path().read_text())),
        "roles": roles, "signals": signals, "notifications": notes,
        "outbox": outbox, "delivery_attempts": attempts, "incidents": incidents,
        "synthetic": True,
    }
    write(f"a17a-state-{label}.json", value)
    print(json.dumps({
        "label": label,
        "role_states": {f"{r['group']}:{r['role']}": r["state"] for r in roles},
        "faulty_roles": [f"{r['group']}:{r['role']}" for r in roles
                         if r["state"] in ("stale", "missing", "failed") or r["error_type"]],
        "signals": len(signals),
        "notifications": {kind: sum(1 for n in notes if n["kind"] == kind)
                          for kind in sorted({n["kind"] for n in notes})},
        "notice_titles": [n["title"] for n in notes if n["kind"] == "system"][-3:],
        "accepted_outbox": [o["provider_id"] for o in outbox if o["status"] == "accepted"],
        "synthetic": True,
    }, ensure_ascii=False), flush=True)


def rebaseline(net, control, timeout):
    """Re-arm the seeded ChartAlerts once the fixture owner publishes a sample.

    Safe alert creation requires a fresh source observation, so the rebaseline
    retries until the fixture clock window matches instead of forcing state.
    """
    started = time.monotonic()
    last = None
    while time.monotonic() - started < timeout:
        try:
            net.restart_rules(control)
            print(json.dumps({"phase": "rebaseline", "elapsed_s": round(
                time.monotonic() - started, 2), "passed": True}), flush=True)
            return
        except Exception as exc:  # readiness races are expected in this window
            last = f"{type(exc).__name__}: {exc}"
            time.sleep(2)
    print(json.dumps({"phase": "rebaseline", "passed": False, "error": last}), flush=True)
    raise SystemExit(1)


def maintenance_window(minutes, groups=()):
    """Open or clear the bounded window on the fixture's own time base."""
    from alerts.runtime_health import clear_maintenance, maintain
    from alerts.storage import bootstrap, transaction

    bootstrap()
    with transaction() as db:
        if minutes <= 0:
            clear_maintenance(db)
            print(json.dumps({"maintenance": "cleared"}), flush=True)
        else:
            print(json.dumps({"maintenance": maintain(db, minutes=minutes,
                                                         groups=list(groups))},
                             ensure_ascii=False), flush=True)


def solo(keep):
    """Pause every seeded alert but `keep` so one crossing yields one signal."""
    from sqlalchemy import select

    from alerts.chart_alert_service import lifecycle
    from alerts.storage import ChartAlert, Session, now_ms

    with Session() as db:
        rows = [row for row in db.scalars(select(ChartAlert).order_by(ChartAlert.id))
                if row.status == "active"]
    keep_ids = [row.id for row in rows[:keep]]
    paused = 0
    for row in rows[keep:]:
        with Session.begin() as db:
            lifecycle(db, row.id, row.version, "pause",
                      expected_revision=row.control_revision,
                      request_id="a17a-solo-" + row.id, at=now_ms())
        paused += 1
    print(json.dumps({"phase": "solo", "active_before": len(rows),
                      "kept": keep_ids, "paused": paused}, ensure_ascii=False), flush=True)


def cross(control):
    """Drive the synthetic quote crossing used by every seeded rule."""
    import httpx

    response = httpx.post("http://127.0.0.1:8080/fixture/price", json={"price": "1.119"},
                          timeout=10)
    response.raise_for_status()
    print(json.dumps({"phase": "cross", "price": "1.119",
                      "fixture": response.json()}, ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=(
        "seed", "supplier", "runtime", "state", "rebaseline", "cross", "solo",
        "maintenance", "api"))
    parser.add_argument("--minutes", type=int, default=0)
    parser.add_argument("--group", dest="groups", action="append", default=[])
    parser.add_argument("--profile", choices=("market", "data", "notifications"),
                        default="market")
    parser.add_argument("--label", default="snapshot")
    parser.add_argument("--timeout", type=float, default=120)
    args = parser.parse_args()
    guard()
    if args.action == "seed":
        seed({})
        return
    control = json.loads(control_path().read_text())
    import runtime_market_network_acceptance as net

    configure(control)
    if args.action == "supplier":
        net.supplier(control)
    elif args.action == "runtime":
        # MW_A17A_FAULT injects one controlled loop failure (stage-2 fixture).
        net.runtime(control, args.profile, os.environ.get("MW_A17A_FAULT") or None)
    elif args.action == "rebaseline":
        rebaseline(net, control, args.timeout)
    elif args.action == "cross":
        cross(control)
    elif args.action == "api":
        import uvicorn

        uvicorn.run("alerts.api:app", host="0.0.0.0", port=8000)
    elif args.action == "maintenance":
        maintenance_window(args.minutes, args.groups)
    elif args.action == "solo":
        solo(int(os.environ.get("MW_A17A_SOLO_KEEP", "1")))
    else:
        state(args.label)


if __name__ == "__main__":
    main()
