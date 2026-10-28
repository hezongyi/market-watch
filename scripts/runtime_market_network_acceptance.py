"""Container-only synthetic OANDA wire fixture and real runtime-profile probes.

No production endpoints or credentials are used. Only HTTP destination and the
fixture clock are substituted; parsing, collection, publication, leases,
aggregation, indicators, alert evaluation and lifecycle use production code.
"""

import argparse
import json
import logging
import os
import re
import sys
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

ROOT = Path("/artifacts")
ACCOUNT = "composite-test-account"


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2))


def clock(control):
    return control["business_origin"] + int((time.monotonic() - control["monotonic_origin"]) * 1000)


def seed(run):
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
    from runtime_market_baseline import seed as baseline_seed
    from sqlalchemy import delete, text

    schema = "runtime_network_" + run
    with storage.engine.begin() as db:
        db.execute(text(f"CREATE SCHEMA {schema}"))
    engine, factory, patch, ids, composite, revision, seam, stamp, target, inventory = baseline_seed(schema, "normal")
    storage.bootstrap(engine)
    with factory.begin() as db:
        db.execute(delete(ProviderInterest).where(ProviderInterest.id == "baseline-foreground"))
        for name in ("BTCUSDT", "ETHUSDT", "EURUSD", "XAUUSD"):
            if db.get(Instrument, name):
                set_enabled(db, name, False, now=stamp)
        owner = db.get(PricingOwner, account_key(ACCOUNT))
        owner.token, owner.expires, owner.next_at, owner.error = None, 0, 0, None
        db.merge(Preference(key="runtime_network_fixture", value={"run": run, "synthetic": True}))
        if settings.oanda_acquisition_mode == "rest_batch":
            composite_row = db.get(MarketComposite, composite)
            revision_row = db.get(CompositeRevision, revision)
            target_row = db.get(RealtimeMapping, revision_row.mapping_id)
            target_instrument = db.get(MarketDataset, target_row.target_dataset_id).instrument_id
            set_enabled(db, target_instrument, True, now=stamp)
            db.add(MarketDemand(id="acceptance-" + run, instrument_id=composite_row.instrument_id,
                composite_revision_id=revision, expires=stamp + 3600000))
    control = {"run": run, "schema": schema, "business_origin": stamp,
        "monotonic_origin": time.monotonic(), "rules": ids, "rule_modes": inventory["rule_modes"],
        "composite": composite, "revision": revision, "target": target, "seam": seam,
        "calendar_version": settings.oanda_calendar_version, "synthetic": True}
    write(ROOT / f"network-{run}-control.json", control)
    engine.dispose()
    patch.undo()
    print(json.dumps({"seeded": run, "rules": len(ids), "synthetic": True}), flush=True)


def supplier(control):
    lock = threading.Lock()
    state = {"price": "1.110", "closes": {}, "requests": {}}

    def quote():
        with lock:
            stamp, price = clock(control), state["price"]
            state["closes"][stamp // 60000 * 60000] = price
        return {"type": "PRICE", "instrument": "EUR_USD", "time": str(stamp / 1000),
                "tradeable": True, "bids": [{"price": price}],
                "asks": [{"price": str(float(price) + .001)}]}

    def candle(at, complete):
        with lock:
            price = state["closes"].get(at, "1.110") if complete else state["price"]
            if not complete:
                state["closes"][at] = price
        return {"time": str(at / 1000), "complete": complete, "volume": 3,
                "bid": {"o": "1.10", "h": "1.12", "l": "1.09", "c": price}}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def respond(self, value):
            body = json.dumps(value).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            if self.path != "/fixture/price":
                self.send_error(404)
                return
            value = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if value.get("price") not in ("1.110", "1.119"):
                self.send_error(400)
                return
            with lock:
                state["price"] = value["price"]
                state["closes"][clock(control) // 60000 * 60000] = value["price"]
            self.respond({"price": value["price"], "at": clock(control)})

        def do_GET(self):
            parsed = urlparse(self.path)
            path, params = parsed.path, parse_qs(parsed.query)
            with lock:
                state["requests"][path] = state["requests"].get(path, 0) + 1
            if path == "/fixture/state":
                with lock:
                    value = {"price": state["price"], "requests": dict(state["requests"])}
                self.respond({**value, "at": clock(control), "synthetic": True})
            elif path == "/v3/accounts":
                self.respond({"accounts": [{"id": ACCOUNT}]})
            elif path.endswith("/summary"):
                self.respond({"account": {"id": ACCOUNT}})
            elif path.endswith("/instruments"):
                self.respond({"instruments": [{"name": "EUR_USD", "displayName": "Fixture EUR/USD",
                                               "displayPrecision": 5}]})
            elif path.endswith("/pricing/stream"):
                self.send_response(200)
                self.send_header("Content-Type", "application/x-ndjson")
                self.end_headers()
                try:
                    while True:
                        self.wfile.write(json.dumps(quote()).encode() + b"\n")
                        self.wfile.flush()
                        time.sleep(.5)
                except (BrokenPipeError, ConnectionResetError):
                    return
            elif path.endswith("/pricing"):
                self.respond({"prices": [quote()]})
            elif path.endswith("/candles/latest"):
                at = clock(control) // 60000 * 60000
                self.respond({"latestCandles": [{"instrument": "EUR_USD", "granularity": "M1",
                    "candles": [candle(at - 60000, True), candle(at, False)]}]})
            elif path.endswith("/candles"):
                start, end = (int(float(params[name][0]) * 1000) for name in ("from", "to"))
                if not 0 <= end - start <= 4000 * 60000:
                    self.send_error(400)
                    return
                end = min(end, clock(control) // 60000 * 60000)
                self.respond({"instrument": "EUR_USD", "granularity": "M1",
                              "candles": [candle(at, True) for at in range(start, end, 60000)]})
            else:
                self.send_error(404)

    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()


def configure(control):
    from alerts import storage
    from alerts.config import settings

    class FixtureDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls.fromtimestamp(clock(control) / 1000, tz)

    storage.datetime = FixtureDatetime
    settings.oanda_calendar_version = control["calendar_version"]


def runtime(control, profile, fault):
    import httpx
    from alerts import market_runtime, oanda_worker
    from alerts.oanda_rest_batch import OandaRestBatch
    from alerts.oanda_stream import OandaPractice

    class FixtureTransport(httpx.BaseTransport):
        def __init__(self):
            self.transport = httpx.HTTPTransport()

        def handle_request(self, request):
            if request.url.host not in ("api-fxpractice.oanda.com", "stream-fxpractice.oanda.com"):
                raise ValueError("Unexpected fixture destination")
            request.url = request.url.copy_with(scheme="http", host="fixture-supplier", port=8080)
            request.headers["host"] = "fixture-supplier:8080"
            return self.transport.handle_request(request)

        def close(self):
            self.transport.close()

    class FixtureClients:
        def __init__(self, **kwargs):
            kwargs["rest_client"] = httpx.Client(transport=FixtureTransport(), timeout=5)
            kwargs["stream_client"] = httpx.Client(transport=FixtureTransport(), timeout=5)
            kwargs["clock"] = lambda: clock(control)
            super().__init__(**kwargs)

        def close(self):
            super().close()
            self.rest.close()
            self.stream_client.close()

    class FixturePractice(FixtureClients, OandaPractice):
        pass

    class FixtureBatch(FixtureClients, OandaRestBatch):
        pass

    oanda_worker.OandaPractice, oanda_worker.OandaRestBatch = FixturePractice, FixtureBatch
    if fault:
        original = market_runtime.build_loops
        from alerts.runtime_health import progress
        from alerts.runtime_supervisor import Loop

        def injected(stop):
            progress()
            if fault == "exception":
                stop.wait(5)
                raise RuntimeError("Controlled acceptance loop failure")
            # Remain responsive to shutdown, but never advance this heartbeat.
            stop.wait()

        market_runtime.build_loops = lambda: tuple(
            Loop(loop.role, injected) if loop.role == "composite_aggregate" else loop
            for loop in original())
    from alerts.runtime import main

    sys.argv = ["alerts.runtime", "--profile", profile]
    main()


def snapshot(control):
    from alerts import runtime_health
    from alerts.live_pricing import account_key
    from alerts.storage import (
        ChartAlert,
        CompositeAggregateTask,
        LiveState,
        PricingOwner,
        Session,
        SignalRow,
    )
    from sqlalchemy import select

    with Session() as db:
        source = db.get(LiveState, control["target"])
        owner = db.get(PricingOwner, account_key(ACCOUNT))
        task = db.get(CompositeAggregateTask, (control["revision"], "M1"))
        business_now = clock(control)
        return {"at": time.monotonic(), "business_at": business_now,
            "roles": runtime_health.summary(db),
            "source": {"ready": source.ready, "epoch": source.epoch,
                       "owner_valid": bool(owner and owner.token and owner.expires > clock(control)
                                           and owner.epoch == source.epoch),
                       "revision": source.revision, "confirmed_end": source.confirmed_end,
                       "observation_mode": ("candle_close_sample" if
                           (source.forming or {}).get("acquisition_mode") == "rest_batch" else "stream_quote"),
                       "received_age_ms": business_now - source.received_at},
            "aggregate_revision": task.applied_input_revision if task else None,
            "rules": [{"id": row.id, "health": row.health, "reason": row.health_reason,
                       "count": row.count, "runtime": row.runtime, "state": row.state}
                      for row in db.scalars(select(ChartAlert).where(ChartAlert.id.in_(control["rules"])))],
            "signals": [{"id": row.id, "rule": row.chart_alert_id, "occurred_at": row.occurred_at}
                        for row in db.scalars(select(SignalRow).order_by(SignalRow.id))]}


def restart_rules(control):
    """Rebaseline synthetic rules after the real acquisition owner is healthy."""
    from alerts.chart_alert_service import lifecycle
    from alerts.storage import ChartAlert, Session, now_ms

    before = snapshot(control)
    if (not before["source"]["ready"] or not before["source"]["owner_valid"]
            or before["source"]["received_age_ms"] < 0
            or before["source"]["received_age_ms"] > 15000):
        raise RuntimeError("Cannot restart rules before the live owner is ready")
    if (os.environ.get("ALERTS_OANDA_ACQUISITION_MODE") == "rest_batch"
            and before["source"]["observation_mode"] != "candle_close_sample"):
        raise RuntimeError("REST-Batch owner has not published a candle sample")
    with Session.begin() as db:
        for ident in control["rules"]:
            row = db.get(ChartAlert, ident)
            if row is None:
                raise RuntimeError(f"Missing synthetic rule: {ident}")
            lifecycle(db, ident, row.version, "restart", expected_revision=row.control_revision,
                      request_id=f"{control['run']}-rest-restart-{ident}", at=now_ms())
    value = snapshot(control)
    value.update(phase="restart", synthetic=True)
    write(ROOT / f"network-{control['run']}-restart.json", value)
    print(json.dumps({"phase": "restart", "rules": len(control["rules"]),
                      "signals": len(value["signals"]), "passed": True}), flush=True)


def demand_lease(control, enabled):
    from alerts.storage import MarketComposite, MarketDemand, Session, now_ms

    ident = "acceptance-" + control["run"]
    with Session.begin() as db:
        row = db.get(MarketDemand, ident)
        if enabled:
            composite = db.get(MarketComposite, control["composite"])
            if not composite:
                raise RuntimeError("Missing synthetic composite")
            if row is None:
                row = MarketDemand(id=ident, instrument_id=composite.instrument_id,
                    composite_revision_id=control["revision"], expires=now_ms() + 3600000)
                db.add(row)
            else:
                row.expires = now_ms() + 3600000
        elif row is not None:
            db.delete(row)
    value = snapshot(control)
    phase = "demand-lease-on" if enabled else "demand-lease-off"
    value.update(phase=phase, synthetic=True)
    write(ROOT / f"network-{control['run']}-{phase}.json", value)
    print(json.dumps({"phase": phase, "lease_present": enabled, "passed": True}), flush=True)


def check(control, phase, timeout):
    import httpx

    def ready(value):
        return (value["source"]["ready"] and value["source"]["owner_valid"]
                and len(value["rules"]) == len(control["rules"])
                and all(row["health"] == "ready" for row in value["rules"])
                and all(row["state"] not in ("missing", "starting", "stale", "stopped", "failed")
                        for row in value["roles"]))

    start = time.monotonic()
    previous = ROOT / f"network-{control['run']}-checkpoint.json"
    old = json.loads(previous.read_text()) if phase == "recovered" else None
    if phase == "crossing":
        response = httpx.post("http://fixture-supplier:8080/fixture/price", json={"price": "1.119"})
        response.raise_for_status()
    while time.monotonic() - start < timeout:
        if old and time.monotonic() - old["at"] > 60:
            break
        value = snapshot(control)
        if phase in ("ready", "checkpoint"):
            done = ready(value)
        elif phase == "source-ready":
            done = (value["source"]["ready"] and value["source"]["owner_valid"]
                    and 0 <= value["source"]["received_age_ms"] <= 15000
                    and all(row["state"] not in ("stale", "missing", "failed")
                            for row in value["roles"]))
            if os.environ.get("ALERTS_OANDA_ACQUISITION_MODE") == "rest_batch":
                done = done and value["source"]["observation_mode"] == "candle_close_sample"
        elif phase == "crossing":
            done = ready(value) and all(row["count"] == 1 for row in value["rules"])
        elif phase == "recovered":
            old_boot = {row["role"]: row.get("boot_id") for row in old["roles"]}
            done = (ready(value) and value["source"]["epoch"] > old["source"]["epoch"]
                    and all(row.get("boot_id") != old_boot.get(row["role"]) for row in value["roles"])
                    and value["signals"] == old["signals"])
        elif phase == "stuck":
            statuses = {row["role"]: row["state"] for row in value["roles"]}
            done = statuses.get("composite_aggregate") == "stale" and all(
                statuses.get(role) not in ("stale", "missing", "failed")
                for role in ("pricing", "realtime", "alert_indicator", "market_ownership", "chart_alert"))
        elif phase == "failed":
            done = any(row["role"] == "composite_aggregate" and row["state"] == "failed"
                       for row in value["roles"])
        else:
            raise ValueError("Unknown verification phase")
        if done:
            value.update(phase=phase, elapsed_s=time.monotonic() - start, synthetic=True)
            if old:
                value["restart_since_checkpoint_s"] = time.monotonic() - old["at"]
            write(ROOT / f"network-{control['run']}-{phase}.json", value)
            if phase == "checkpoint":
                write(previous, value)
            print(json.dumps({"phase": phase, "elapsed_s": value["elapsed_s"],
                              "signals": len(value["signals"]), "passed": True}), flush=True)
            return
        time.sleep(.25)
    write(ROOT / f"network-{control['run']}-{phase}-failure.json", value)
    raise RuntimeError(f"Network acceptance did not reach {phase} within {timeout}s")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("seed", "supplier", "runtime", "api", "check", "restart",
                                             "demand-on", "demand-off", "status"))
    parser.add_argument("--profile", choices=("market", "alert"), default="market")
    parser.add_argument("--fault", choices=("exception", "stuck"))
    parser.add_argument("--phase", default="ready")
    parser.add_argument("--timeout", type=float, default=60)
    args = parser.parse_args()
    run = os.environ.get("MW_RUNTIME_NETWORK_RUN", "")
    parsed = urlparse(os.environ.get("ALERTS_DATABASE_URL", ""))
    if (not re.fullmatch(r"[a-z][a-z0-9_]{0,36}", run) or parsed.hostname != "postgres"
            or parsed.path != "/runtime_profile"
            or os.environ.get("ALERTS_DELIVERY_ENABLED") != "false"):
        raise RuntimeError("Only the isolated runtime_profile task database is allowed")
    query = parse_qs(parsed.query)
    query["options"] = ["-csearch_path=runtime_network_" + run]
    os.environ["ALERTS_DATABASE_URL"] = urlunparse(parsed._replace(query=urlencode(query, doseq=True)))
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    if args.action == "seed":
        seed(run)
        return
    control = json.loads((ROOT / f"network-{run}-control.json").read_text())
    configure(control)
    if args.action == "supplier":
        supplier(control)
    elif args.action == "runtime":
        runtime(control, args.profile, args.fault)
    elif args.action == "check":
        check(control, args.phase, args.timeout)
    elif args.action == "restart":
        restart_rules(control)
    elif args.action in ("demand-on", "demand-off"):
        demand_lease(control, args.action == "demand-on")
    elif args.action == "api":
        import uvicorn

        uvicorn.run("alerts.api:app", host="0.0.0.0", port=8000)
    else:
        print(json.dumps(snapshot(control), ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
