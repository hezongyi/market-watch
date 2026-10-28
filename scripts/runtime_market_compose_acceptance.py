"""Run the measured stage-2 owners as separate Compose containers."""

import argparse
import json
import os
import signal
import time
import uuid
from pathlib import Path

from runtime_market_baseline import connect, seed, source_evidence, worker
from sqlalchemy import func, select, text

CONTROL = Path("/artifacts/compose-control.json")
ARTIFACTS = Path("/artifacts")


def seed_run(run, origin_delay):
    from alerts import storage

    schema = "runtime_compose_" + run
    admin = storage.make_engine(os.environ["ALERTS_DATABASE_URL"])
    with admin.begin() as db:
        db.execute(text(f"CREATE SCHEMA {schema}"))
    admin.dispose()
    engine, factory, patch, ids, composite, revision, seam, stamp, target, inventory = seed(
        schema, "normal")
    engine.dispose()
    patch.undo()
    began = time.monotonic() + origin_delay
    value = {
        "run": run, "schema": schema, "business_origin": stamp,
        "monotonic_origin": began, "revision": revision,
        "rules": ids, "inventory": inventory,
        "target": target, "seam": seam,
    }
    CONTROL.write_text(json.dumps(value, indent=2))
    print(json.dumps({"schema": schema, "origin_in_s": origin_delay, "rules": len(ids)}),
          flush=True)


def run_worker(role):
    control = json.loads(CONTROL.read_text())
    url = os.environ["ALERTS_DATABASE_URL"]
    from sqlalchemy.engine import make_url

    parsed = make_url(url)
    query = dict(parsed.query)
    query["options"] = "-csearch_path=" + control["schema"]
    os.environ["ALERTS_DATABASE_URL"] = str(parsed.set(query=query))
    import multiprocessing as mp

    stopped = mp.Event()
    signal.signal(signal.SIGTERM, lambda *_: stopped.set())
    signal.signal(signal.SIGINT, lambda *_: stopped.set())
    prefix = ARTIFACTS / (control["schema"] + "-")
    log = Path(str(prefix) + role + ".jsonl")
    worker(role, control["schema"],
           (control["business_origin"], control["monotonic_origin"]),
           stopped, control["revision"], "busy", log, 1,
           control["inventory"], True, True)


def drive(samples, interval):
    from alerts.storage import (
        ChartAlert,
        CompositeAggregateTask,
        CompositePreparation,
        FixedIndicatorRun,
        HistoryVersion,
        LiveState,
        NoticeEvent,
        Notification,
        Outbox,
        SignalRow,
    )
    from runtime_market_baseline import sample_quote
    from test_fixed_indicators import add_tail
    from test_market_contracts import minute

    control = json.loads(CONTROL.read_text())
    engine, factory = connect(control["schema"])
    origin, began = control["business_origin"], control["monotonic_origin"]
    while time.monotonic() < began:
        time.sleep(min(0.1, began - time.monotonic()))
    inputs, resources = [], []
    confirmed_end, previous_price = origin // 60000 * 60000, "1.110"
    roles = ("runtime", "alert", "provider", "notification", "projection", "history")
    for index in range(samples):
        due = began + index * interval
        time.sleep(max(0, due - time.monotonic()))
        issued = time.monotonic()
        business_now = origin + int((issued - began) * 1000)
        end = business_now // 60000 * 60000
        confirmed = end > confirmed_end
        if confirmed:
            add_tail(factory, control["revision"],
                     [minute(end - 60000, volume="3", close=previous_price)],
                     observed_at=business_now)
            confirmed_end = end
        high = any(left <= index < right for left, right in (
            (3, 14), (max(15, samples // 2 - 3), max(16, samples // 2 + 8)),
            (max(25, samples - 3), samples)))
        price = "1.119" if high else "1.110"
        sample_quote(factory, control["revision"], end, business_now, price)
        with factory.begin() as db:
            input_revision = db.get(CompositePreparation, control["revision"]).input_revision
        committed = time.monotonic()
        previous_price = price
        inputs.append({"sample": index, "issued": issued, "committed": committed,
                       "end": end, "business_now": business_now,
                       "confirmed_minute": confirmed, "input_revision": input_revision,
                       "price": price})
        with factory.begin() as db:
            backlog = {
                "history": [list(row) for row in db.execute(select(HistoryVersion.status,
                    func.count()).group_by(HistoryVersion.status)).all()],
                "indicators": [list(row) for row in db.execute(select(FixedIndicatorRun.status,
                    func.count()).group_by(FixedIndicatorRun.status)).all()],
                "aggregate_tasks": db.scalar(select(func.count()).select_from(CompositeAggregateTask)),
            }
            pg = db.execute(text("SELECT numbackends, xact_commit, blks_read, blks_hit, "
                "tup_returned,tup_fetched,tup_inserted,tup_updated,tup_deleted "
                "FROM pg_stat_database WHERE datname=current_database()")).mappings().one()
            live = db.get(LiveState, control["target"])
        processes = []
        for role in roles:
            processes.append({"role": role, "alive": True, "rss": None, "threads": None})
        resources.append({"at": time.monotonic(), "backlog": backlog, "pg": dict(pg),
                          "processes": processes, "host_loadavg": os.getloadavg(),
                          "cgroup_cpu_stat": "per-container metrics in Compose inspect",
                          "cgroup_memory_events": "per-container metrics in Compose inspect",
                          "confirmed_end": live.confirmed_end if live else None})
    input_window_ended = time.monotonic()
    time.sleep(interval + 4)
    with factory.begin() as db:
        final = {
            "rules": [{"id": row.id, "status": row.status, "health": row.health,
                       "count": row.count, "state": row.state, "runtime": row.runtime}
                      for row in db.scalars(select(ChartAlert))],
            "signals": [{"id": row.id, "rule": row.chart_alert_id,
                         "occurred_at": row.occurred_at} for row in db.scalars(select(SignalRow))],
            "notifications": [{"id": row.id, "signal": row.signal_id, "status": row.status}
                              for row in db.scalars(select(Notification))],
            "outbox": [{"id": row.id, "note": row.notification_id,
                        "status": row.status, "attempts": row.attempts}
                       for row in db.scalars(select(Outbox))],
            "notices": [{"id": row.id, "source": row.source_id, "kind": row.source_kind}
                        for row in db.scalars(select(NoticeEvent))],
        }
    result = {
        "scenario": "busy", "schema": control["schema"], "synthetic": True,
        "profile_runtime": True, "independent_alert": True, "samples": samples,
        "interval_s": interval, "history_pause_s": 1,
        "wall_s": time.monotonic() - began, "inventory": control["inventory"],
        "input_window_ended": input_window_ended, "inputs": inputs,
        "resources": resources, "final": final,
        "workers": {role: 0 for role in roles},
        "source_evidence": source_evidence(),
        "compose_limits": {
            "postgres": {"cpus": 0.75, "memory_mib": 768},
            "owners": {
                "runtime": {"cpus": 0.5, "memory_mib": 512},
                "alert": {"cpus": 0.5, "memory_mib": 384},
                "provider": {"cpus": 0.1, "memory_mib": 128},
                "notification": {"cpus": 0.1, "memory_mib": 128},
                "projection": {"cpus": 0.1, "memory_mib": 128},
                "history": {"cpus": 0.2, "memory_mib": 256},
            },
        },
        "limitations": ["Synthetic inputs and local delivery stub; no production network IO",
                        "Six owner roles run in separate Compose containers; PostgreSQL is isolated"],
    }
    output = ARTIFACTS / (control["schema"] + ".json")
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    engine.dispose()
    print(json.dumps({"artifact": str(output), "signals": len(final["signals"]),
                      "confirmed_inputs": sum(row["confirmed_minute"] for row in inputs)}),
          flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("seed", "worker", "drive"))
    parser.add_argument("--run", default=None)
    parser.add_argument("--role", choices=("runtime", "alert", "provider", "notification",
                                             "projection", "history"))
    parser.add_argument("--origin-delay", type=float, default=45)
    parser.add_argument("--samples", type=int, default=601)
    parser.add_argument("--interval", type=float, default=2)
    args = parser.parse_args()
    if args.action == "seed":
        seed_run(args.run or uuid.uuid4().hex[:8], args.origin_delay)
    elif args.action == "worker":
        if not args.role:
            parser.error("worker requires --role")
        run_worker(args.role)
    else:
        drive(args.samples, args.interval)


if __name__ == "__main__":
    main()
