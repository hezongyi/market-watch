"""Stage-0 controlled workload on the task's isolated Ubuntu PostgreSQL only.

Uses existing domain fixtures and production operations, with separate processes
for existing owners. No production access, supplier IO, schema deletion or real
notification. Fixture business time advances at wall-clock speed; latency uses
monotonic time. A fresh confirmed M1 is inserted only at a minute boundary.
"""

import argparse
import json
import multiprocessing as mp
import os
import resource
import time
import traceback
import uuid
from decimal import Decimal
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from alerts import storage
from alerts.config import settings
from sqlalchemy import event, func, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker

OUT = Path("/artifacts")


def emit(path, value):
    with path.open("a") as stream:
        stream.write(json.dumps(value, ensure_ascii=False) + "\n")


def connect(schema):
    url = make_url(settings.database_url).update_query_dict(
        {"options": f"-csearch_path={schema}"}
    )
    engine = storage.make_engine(str(url.render_as_string(hide_password=False)))
    storage.Session = sessionmaker(engine, expire_on_commit=False)
    return engine, storage.Session


def metrics(engine):
    result = {"sql": 0, "reads": 0, "writes": 0, "pool_acquire_s": [], "sql_s": []}
    acquire = engine.pool._do_get

    def measured_get():
        started = time.monotonic()
        try:
            return acquire()
        finally:
            result["pool_acquire_s"].append(time.monotonic() - started)

    engine.pool._do_get = measured_get

    @event.listens_for(engine, "before_cursor_execute")
    def before(conn, cursor, statement, parameters, context, many):
        context.baseline_started = time.monotonic()
        result["sql"] += 1
        kind = statement.lstrip().split()[0].upper() if statement.strip() else ""
        result["reads"] += kind in ("SELECT", "WITH")
        result["writes"] += kind in ("INSERT", "UPDATE", "DELETE")

    @event.listens_for(engine, "after_cursor_execute")
    def after(conn, cursor, statement, parameters, context, many):
        result["sql_s"].append(time.monotonic() - context.baseline_started)

    return result


def distribution(values):
    ordered = sorted(values)
    if not ordered:
        return {"n": 0}
    return {"n": len(ordered), "p50": ordered[len(ordered) // 2],
            "p95": ordered[min(len(ordered) - 1, int(len(ordered) * .95))],
            "p99": ordered[min(len(ordered) - 1, int(len(ordered) * .99))],
            "max": ordered[-1]}


class HistoryAdapter:
    """Explicit synthetic paginated source with bounded IO wait."""

    def page(self, identity, start, end):
        from alerts.source_registry import capabilities
        from test_market_contracts import batch, minute

        time.sleep(.15)
        checkpoint = min(end, start + 120 * 60000)
        contract = capabilities(identity.source)
        return batch(identity=identity, window_start=start, window_end=end,
                     checkpoint=checkpoint, observed_at=end + 5000,
                     volume_kind=contract["volume_kind"], volume_unit=contract["volume_unit"],
                     rows=tuple(minute(at, volume="3") for at in range(start, checkpoint, 60000)))


def sample_quote(factory, revision, at, stamp, price):
    from alerts.display_observations import accept
    from alerts.live_pricing import account_key
    from alerts.market_contracts import DatasetIdentity, QuoteEvent
    from alerts.storage import (
        CompositeRevision,
        HistoryVersion,
        Instrument,
        LiveState,
        MarketDataset,
        PricingOwner,
        RealtimeMapping,
    )

    # The unit-test forming helper commits a default quote before the actual
    # sample. Concurrent readers must see one coherent source transaction.
    with factory.begin() as db:
        rev = db.get(CompositeRevision, revision)
        target = db.get(RealtimeMapping, rev.mapping_id).target_dataset_id
        history = db.get(HistoryVersion, rev.history_version_id)
        # Respect the existing evidence/reference writers' dataset lock order
        # before mutating LiveState, whose FK checks also touch the dataset.
        list(db.scalars(select(MarketDataset.id).where(MarketDataset.id.in_(
            [target, history.dataset_id])).order_by(MarketDataset.id).with_for_update()))
        state = db.get(LiveState, target)
        owner = db.get(PricingOwner, account_key(settings.oanda_account_id))
        owner.expires = stamp + 60000
        state.received_at = state.heartbeat_at = stamp
        state.confirmed_end = at
        dataset = db.get(MarketDataset, target)
        sample = QuoteEvent(identity=DatasetIdentity.model_validate(dataset.identity),
            bid=price, ask=str(Decimal(price) + Decimal(".001")), tradeable=True,
            source_time=stamp, received_at=stamp, sequence=stamp, connection_epoch=state.epoch)
        state.quote = sample.model_dump()
        observed = accept(db, state, sample, stamp=stamp,
                          profile=db.get(Instrument, dataset.instrument_id).calendar_profile)
        if observed is None:
            raise RuntimeError("Fixture source observation was not accepted")
        state.forming = dict(observed.content)


def worker(role, schema, clock_origin, stopped, revision, scenario, log, history_pause, tracked):
    engine, factory = connect(schema)
    measured = metrics(engine)
    started = time.monotonic()
    try:
        if role == "alert":
            from alerts import chart_alert_worker
            from alerts.alert_monitor import run
            from alerts.storage import Notification, Outbox, SignalRow

            # The observer's clock must advance independently of source writes.
            # A sampled shared clock lags after commit and invents future quotes.
            chart_alert_worker.now_ms = lambda: clock_origin[0] + int(
                (time.monotonic() - clock_origin[1]) * 1000)
            seen = set()

            def evaluated(item):
                emit(log, {"type": "evaluated", **item})
                if not item["count"]:
                    return
                with factory() as db:
                    rows = db.execute(select(SignalRow.id, SignalRow.occurred_at,
                        Notification.id, Outbox.id).join(Notification,
                        Notification.signal_id == SignalRow.id).join(Outbox,
                        Outbox.notification_id == Notification.id).where(
                        SignalRow.chart_alert_id == item["alert_id"])).all()
                for signal, occurred, note, outbox in rows:
                    if signal not in seen:
                        seen.add(signal)
                        emit(log, {"type": "signal", "signal": signal, "note": note,
                            "outbox": outbox, "occurred_at": occurred,
                            "rule": item["alert_id"], "committed": item["committed"],
                            "observed_at": time.monotonic()})

            run(stopped, on_alert=evaluated)
        elif role == "aggregate":
            from alerts.composite_aggregates import aggregate_tick
            from alerts.storage import CompositeAggregateTask

            while not stopped.is_set():
                progressed = aggregate_tick()
                with factory() as db:
                    task = db.get(CompositeAggregateTask, (revision, "M1"))
                    published = task.applied_input_revision if task else -1
                emit(log, {"type": "aggregate", "at": time.monotonic(),
                           "progressed": bool(progressed), "published_revision": published})
                stopped.wait(.05 if progressed else .5)
        elif role == "history":
            from alerts.composite_revisions import readiness
            from alerts.history_versions import worker_tick
            from alerts.storage import CompositeRevision, FixedIndicatorRun, HistoryArtifact

            while not stopped.is_set():
                progressed = worker_tick(HistoryAdapter(), without_composite_aggregates=True)
                emit(log, {"type": "history", "at": time.monotonic(),
                           "progressed": bool(progressed)})
                if tracked["candidate_history"]:
                    with factory() as db:
                        artifacts = [(row.timeframe, row.status) for row in db.scalars(
                            select(HistoryArtifact).where(
                                HistoryArtifact.version_id == tracked["candidate_history"]))]
                        indicators = [(row.id, row.status, row.cursor, row.target_end)
                            for row in db.scalars(select(FixedIndicatorRun).where(
                                FixedIndicatorRun.history_version_id == tracked["candidate_history"]))]
                        ready = (readiness(db, db.get(CompositeRevision, tracked["candidate_revision"]))
                                 if tracked["candidate_revision"] else None)
                    emit(log, {"type": "candidate", "at": time.monotonic(),
                        "artifacts": artifacts, "indicators": indicators, "readiness": ready})
                stopped.wait(history_pause)
        elif role == "provider":
            from alerts import provider_chart, provider_service
            from alerts.storage import ProviderInterest

            def page(meta, frame, before, count, **kwargs):
                began = time.monotonic()
                if scenario == "slow-source":
                    time.sleep(3)
                    emit(log, {"type": "provider_request", "started": began,
                        "finished": time.monotonic(), "status": "fixture_timeout"})
                    raise TimeoutError("Synthetic slow supplier")
                time.sleep(.1)
                start = before // 60000 * 60000 - count * 60000
                result = {"bars": [{"start": at, "end": at + 60000,
                                  "chart_time": at,
                                  "open": "1.10", "high": "1.12", "low": "1.09",
                                  "close": "1.11", "complete": at + 60000 <= before}
                                 for at in range(start, start + count * 60000, 60000)],
                        "history_boundary": False}
                emit(log, {"type": "provider_request", "started": began,
                    "finished": time.monotonic(), "status": "fixture_data",
                    "last_bar": result["bars"][-1]["start"]})
                return result

            provider_chart.native_page = page
            while not stopped.is_set():
                with factory.begin() as db:
                    for row in db.scalars(select(ProviderInterest)):
                        row.expires = storage.now_ms() + 60000
                began = time.monotonic()
                provider_service.realtime_step("binance")
                emit(log, {"type": "provider", "started": began, "at": time.monotonic()})
                stopped.wait(1)
        elif role == "notification":
            from alerts.notify import deliver_once

            settings.delivery_enabled, settings.ntfy_topic = True, "fixture-only"
            # This client can never reach an external endpoint.
            def accept(request):
                body = json.loads(request.content)
                signal = parse_qs(urlparse(body["click"]).query)["signal"][0]
                note = urlparse(body["actions"][0]["url"]).path.split("/")[-2]
                began = time.monotonic()
                time.sleep(.05)
                emit(log, {"type": "ntfy_accepted", "signal": signal, "note": note,
                    "started": began, "accepted": time.monotonic()})
                return httpx.Response(200, json={"id": "fixture-receipt"})

            with httpx.Client(transport=httpx.MockTransport(accept)) as client:
                while not stopped.is_set():
                    worked = deliver_once(client)
                    emit(log, {"type": "delivery", "at": time.monotonic(), "worked": worked})
                    stopped.wait(.1 if worked else 1)
        elif role == "projection":
            from alerts.notification_center_worker import once
            from alerts.storage import NoticeEvent

            seen = set()
            while not stopped.is_set():
                count = once()
                projected_at = time.monotonic()
                with factory() as db:
                    rows = db.execute(select(NoticeEvent.id, NoticeEvent.source_id,
                                              NoticeEvent.source_kind)).all()
                for ident, source, kind in rows:
                    if ident not in seen:
                        seen.add(ident)
                        emit(log, {"type": "projected", "notice": ident, "source": source,
                                   "source_kind": kind, "committed": projected_at})
                emit(log, {"type": "projection", "at": time.monotonic(), "count": count})
                stopped.wait(.02 if count else 2)
    except BaseException as error:
        emit(log, {"type": "error", "error_type": type(error).__name__})
        traceback.print_exc()
        raise
    finally:
        usage = resource.getrusage(resource.RUSAGE_SELF)
        emit(log, {"type": "metrics", "role": role, "wall_s": time.monotonic() - started,
                   "cpu_s": usage.ru_utime + usage.ru_stime, "max_rss_kib": usage.ru_maxrss,
                   "sql": measured["sql"], "reads": measured["reads"], "writes": measured["writes"],
                   "pool_acquire_including_connect_s": distribution(measured["pool_acquire_s"]),
                   "sql_s": distribution(measured["sql_s"])})
        engine.dispose()


def seed(schema, scenario):
    from alerts.chart_alert_service import create
    from alerts.chart_query import DataQuery, data_sync
    from alerts.history_artifacts import artifact_tick, request_artifacts
    from alerts.history_versions import create_version, import_page
    from alerts.storage import (
        ChartAlert,
        CompositeRevision,
        HistoryVersion,
        LiveState,
        MarketDataset,
        ProviderInterest,
        RealtimeMapping,
    )
    from test_composite_alerts import config, continuous, settle
    from test_market_contracts import batch, identity, minute

    engine, factory = connect(schema)
    storage.Base.metadata.create_all(engine)
    patch = pytest.MonkeyPatch()
    # The semantic test helper normally dates this batch at 210000000, later
    # than our fixture clock. Use a truthful confirmation bound for ATR timing.
    from test_fixed_indicators import add_tail
    patch.setattr("test_composite_alerts.add_tail", lambda database, rev, rows, **kwargs:
        add_tail(database, rev, rows,
                 observed_at=max(row.timestamp for row in rows) + 60000))
    composite, revision, seam, stamp = continuous(factory, patch)
    from alerts.chart_data import FRAMES
    from test_composite_aggregates import drain
    from test_composite_alerts import forming
    forming(factory, revision, stamp // 60000 * 60000, stamp)
    for frame in FRAMES:
        drain(revision, frame)
    ids = []
    modes = {}
    for index in range(7):
        mode = "intrabar" if index in (2, 3, 6) else "close"
        condition = {"relation": "cross_up", "right": {"kind": "constant", "value": "1.115"}}
        if index in (4, 5):
            condition["offset"] = {"kind": "atr", "timeframe": "M1", "period": 2,
                                   "multiplier": ".01"}
        if index == 6:
            condition["left"] = {"kind": "indicator", "indicator":
                {"name": "EMA", "params": {"period": 2}}}
        with factory.begin() as db:
            ids.append(create(db, f"baseline-{index}", config(composite, mode=mode,
                condition=condition, seam_policy="accept_raw", notify_ntfy=True,
                late_delivery="notify"), at=stamp).id)
        modes[ids[-1]] = ("atr_close" if index in (4, 5) else
                         "ema_intrabar" if index == 6 else "price_" + mode)
    for ident in ids:
        settle(factory, ident, stamp)
    # One real PG subscription, with only its protocol adapter synthetic.
    from alerts.provider_cache import ensure
    meta = {"id": "BINANCE:BASELINE", "source": "binance", "symbol": "BASELINE",
            "basis": "last", "calendar": "utc0", "precision": 5}
    dataset = ensure(meta, "M1")
    with factory.begin() as db:
        db.add(ProviderInterest(id="baseline-foreground", client="baseline", listener="main",
            dataset_id=dataset, subscribed=True, expires=storage.now_ms() + 600000,
            accessed_at=storage.now_ms(), targets=[], indicators=[], next_poll=0))
        rev = db.get(CompositeRevision, revision)
        target = db.get(RealtimeMapping, rev.mapping_id).target_dataset_id
        original_history = rev.history_version_id
    if scenario != "normal":
        # Published candidate history: deterministic 2160 M1 rows, nine period
        # artifacts and recursive indicators, while another 20k rows download.
        with factory.begin() as db:
            candidate = create_version(db, identity().key, 0, 2160 * 60000)
        rows = tuple(minute(at) for at in range(0, 2160 * 60000, 60000))
        from test_history_versions import Adapter
        import_page(Adapter([batch(window_end=2160 * 60000, checkpoint=2160 * 60000,
                                   rows=rows)]), version_id=candidate)
        with factory.begin() as db:
            request_artifacts(db, db.get(HistoryVersion, candidate), ["M1", "M5", "H1"])
        while artifact_tick(candidate):
            pass
        for frame in ("M1", "M5", "H1"):
            for period in (19, 50, 100):
                data_sync(DataQuery(instrument=candidate, series_kind="history", timeframe=frame,
                    limit=100, indicators=[{"id": f"ema-{period}", "name": "EMA",
                                            "params": {"period": period}}]))
        with factory.begin() as db:
            download = create_version(db, identity().key, 2160 * 60000, 22160 * 60000)
        if scenario == "candidate":
            from alerts.composite_revisions import create as create_revision
            patch.setattr("alerts.composite_revisions.now_ms", lambda: stamp)
            with factory.begin() as db:
                request_artifacts(db, db.get(HistoryVersion, candidate),
                                  ["M15", "M30", "H4", "D1", "W1", "MN"])
                rev = db.get(CompositeRevision, revision)
                candidate_rev = create_revision(db, composite, {
                    "request_id": "baseline-candidate", "expected_revision_id": revision,
                    "history_version_id": candidate, "mapping_id": rev.mapping_id,
                    "seam": 2160 * 60000, "allow_non_day_boundary": True,
                    "reason": "Stage zero synthetic candidate rebuild contention"})
                candidate_revision = candidate_rev.id
        else:
            candidate_revision = None
    else:
        candidate = download = candidate_revision = None
    with factory.begin() as db:
        inventory = {"rules": [{"id": row.id, "status": row.status, "health": row.health,
                                  "runtime": row.runtime} for row in db.scalars(select(ChartAlert))],
                     "baseline_history": original_history, "candidate_history": candidate,
                     "download": download, "candidate_revision": candidate_revision,
                     "source_identity": db.get(MarketDataset, target).identity,
                     "history_versions": [{"id": row.id, "start": row.start, "end": row.end,
                                            "status": row.status} for row in db.scalars(select(HistoryVersion))],
                     "live": db.get(LiveState, target).ready}
        inventory["rule_modes"] = modes
        inventory["candidate_queued_at"] = time.monotonic() if candidate else None
    # Fixture patch intentionally retained until scenario ends. Its fake account
    # scope is inherited by forked workers; no credentials are ever used on IO.
    return engine, factory, patch, ids, composite, revision, seam, stamp, target, inventory


def scenario_run(name, samples, interval, history_pause):
    schema = "runtime_baseline_" + name.replace("-", "_") + "_" + uuid.uuid4().hex[:8]
    admin = storage.make_engine(settings.database_url)
    with admin.begin() as db:
        db.execute(text(f"CREATE SCHEMA {schema}"))
    admin.dispose()
    engine, factory, patch, ids, composite, revision, seam, stamp, target, inventory = seed(schema, name)
    context = mp.get_context("fork")
    stopped = context.Event()
    began = time.monotonic()
    roles = ["alert", "aggregate", "provider", "notification", "projection", "history"]
    prefix = OUT / (schema + "-")
    processes = []
    # Never inherit live DB connections across fork.
    engine.dispose()
    for role in roles:
        log = Path(str(prefix) + role + ".jsonl")
        process = context.Process(target=worker, args=(role, schema, (stamp, began), stopped,
            revision, name, log, history_pause, inventory), name=role)
        process.start()
        processes.append(process)
    inputs, resources = [], []
    confirmed_end, previous_price = stamp // 60000 * 60000, "1.110"
    try:
        from alerts.storage import (
            ChartAlert,
            CompositeAggregateTask,
            CompositePreparation,
            FixedIndicatorRun,
            HistoryVersion,
            NoticeEvent,
            Notification,
            Outbox,
            SignalRow,
        )
        from test_fixed_indicators import add_tail
        from test_market_contracts import minute

        for index in range(samples):
            due = began + index * interval
            stopped.wait(max(0, due - time.monotonic()))
            if any(not process.is_alive() for process in processes):
                raise RuntimeError("Baseline owner exited early")
            issued = time.monotonic()
            next_business = stamp + int((issued - began) * 1000)
            end = next_business // 60000 * 60000
            confirmed = end > confirmed_end
            if confirmed:
                # Previous observed quote closes the newly finished minute.
                add_tail(factory, revision, [minute(end - 60000, volume="3", close=previous_price)],
                         observed_at=next_business)
                confirmed_end = end
            high = any(left <= index < right for left, right in (
                (3, 14), (max(15, samples // 2 - 3), max(16, samples // 2 + 8)),
                (max(25, samples - 3), samples)))
            price = "1.119" if high else "1.110"
            sample_quote(factory, revision, end, next_business, price)
            with factory.begin() as db:
                input_revision = db.get(CompositePreparation, revision).input_revision
            committed = time.monotonic()
            previous_price = price
            inputs.append({"sample": index, "issued": issued, "committed": committed,
                           "end": end, "business_now": next_business,
                           "confirmed_minute": confirmed,
                           "input_revision": input_revision, "price": price})
            with factory.begin() as db:
                backlog = {"history": [list(row) for row in db.execute(select(HistoryVersion.status,
                    func.count()).group_by(HistoryVersion.status)).all()],
                    "indicators": [list(row) for row in db.execute(select(FixedIndicatorRun.status,
                    func.count()).group_by(FixedIndicatorRun.status)).all()],
                    "aggregate_tasks": db.scalar(select(func.count()).select_from(CompositeAggregateTask))}
                pg = db.execute(text("SELECT numbackends, xact_commit, blks_read, blks_hit, "
                    "tup_returned,tup_fetched,tup_inserted,tup_updated,tup_deleted "
                    "FROM pg_stat_database WHERE datname=current_database()" )).mappings().one()
            processes_info = []
            for process in processes:
                status = Path(f"/proc/{process.pid}/status").read_text()
                fields = {line.split(':')[0]: line.split(':')[1].strip()
                          for line in status.splitlines() if ':' in line}
                processes_info.append({"role": process.name, "pid": process.pid,
                    "rss": fields.get("VmRSS"), "threads": fields.get("Threads")})
            resources.append({"at": time.monotonic(), "backlog": backlog,
                              "pg": dict(pg), "processes": processes_info,
                              "host_loadavg": os.getloadavg(),
                              "cgroup_cpu_stat": Path("/sys/fs/cgroup/cpu.stat").read_text(),
                              "cgroup_memory_events": Path("/sys/fs/cgroup/memory.events").read_text()})
        input_window_ended = time.monotonic()
        stopped.wait(interval + 2)
    finally:
        stopped.set()
        for process in processes:
            process.join(timeout=25)
        alive = [process.name for process in processes if process.is_alive()]
        if alive:
            raise RuntimeError("Baseline workers failed to stop: " + ",".join(alive))
        failed = [process.name for process in processes if process.exitcode != 0]
        if failed:
            raise RuntimeError("Baseline worker failure: " + ",".join(failed))
        workers_stopped = time.monotonic()
        with factory.begin() as db:
            final = {"rules": [{"id": row.id, "status": row.status, "health": row.health,
                                 "count": row.count, "state": row.state, "runtime": row.runtime}
                                for row in db.scalars(select(ChartAlert))],
                     "signals": [{"id": row.id, "rule": row.chart_alert_id,
                                   "occurred_at": row.occurred_at} for row in db.scalars(select(SignalRow))],
                     "notifications": [{"id": row.id, "signal": row.signal_id,
                                        "status": row.status}
                                       for row in db.scalars(select(Notification))],
                     "outbox": [{"id": row.id, "note": row.notification_id,
                                 "status": row.status, "attempts": row.attempts}
                                for row in db.scalars(select(Outbox))],
                     "notices": [{"id": row.id, "source": row.source_id,
                                  "kind": row.source_kind}
                                 for row in db.scalars(select(NoticeEvent))]}
        engine.dispose()
        patch.undo()
    result = {"scenario": name, "schema": schema, "synthetic": True,
              "baseline_sha": "78697159067e1c1bc6c38be8ca8218cd12c29179",
              "clock": "wall-speed fixture stream_quote, confirmed M1 at minute boundary",
              "samples": samples, "interval_s": interval, "history_pause_s": history_pause,
              "wall_s": time.monotonic() - began, "inventory": inventory,
              "input_window_ended": input_window_ended, "workers_stopped": workers_stopped,
              "inputs": inputs, "resources": resources, "final": final,
              "workers": {process.name: process.exitcode for process in processes},
              "limitations": ["Fixture source identity/time origin; no real supplier SLA",
                 "No HTTP/browser transport in stage-zero process workload",
                 "Shared probe cgroup, separate owner processes; not final five-service profile"]}
    (OUT / (schema + ".json")).write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps({"scenario": name, "artifact": schema + ".json",
                      "workers": result["workers"]}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenario", choices=("normal", "busy", "candidate", "slow-source", "all"), default="all")
    parser.add_argument("--samples", type=int, default=61)
    parser.add_argument("--interval", type=float, default=2)
    parser.add_argument("--history-pause", type=float, default=1)
    args = parser.parse_args()
    url = make_url(settings.database_url)
    if (os.environ.get("MW_RUNTIME_BASELINE_TASK") != "mw-runtime-20261026"
            or url.host != "postgres" or url.database != "runtime_baseline"
            or settings.delivery_enabled or settings.oanda_stream_enabled or settings.yahoo_enabled):
        raise RuntimeError("Only the isolated task database with external delivery/sources off is allowed")
    if args.samples < 4 or args.interval < 1 or args.history_pause < .05:
        raise ValueError("At least four samples and a one-second interval are required")
    for scenario in (("normal", "busy", "candidate", "slow-source")
                     if args.scenario == "all" else (args.scenario,)):
        scenario_run(scenario, args.samples, args.interval, args.history_pause)


if __name__ == "__main__":
    main()
