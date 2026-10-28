"""Container-level top-up probes for stage-5 joint acceptance items A06/A09/A10/A11/A12.

Only the HTTP destinations, the fixture clock and the acceptance database schema
are substituted. Provider/stream parsing, publication, leases, aggregation,
indicators, chart alerts, health fencing and notification projection/delivery
use the production modules from the read-only source snapshot.

No production endpoint or credential is used: OANDA/Binance wire traffic is
rewritten to the local fixture-supplier container, the Dukascopy origin is
rewritten to a stub that never answers (injected slow source), and notification
delivery stays disabled with no configured topic.
"""

import argparse
import json
import logging
import os
import re
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

ROOT = Path("/artifacts")
ACCOUNT = os.environ.get("ALERTS_OANDA_ACCOUNT_ID", "composite-test-account")
SUPPLIER = "fixture-supplier"
SLOW_STUB = "/stub/slow"
FRAME_MS = {"M1": 60000, "M5": 300000, "M15": 900000, "M30": 1800000, "H1": 3600000,
            "H4": 14400000, "D1": 86400000}
GRANULARITY_MS = {**FRAME_MS, "S5": 5000}


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2))


def clock(control):
    return control["business_origin"] + int(
        (time.monotonic() - control["monotonic_origin"]) * 1000)


def configure(control):
    from alerts import storage
    from alerts.config import settings

    class FixtureDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls.fromtimestamp(clock(control) / 1000, tz)

    storage.datetime = FixtureDatetime
    settings.oanda_calendar_version = control["calendar_version"]


# --------------------------------------------------------------------- seed
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
        ProviderDataset,
        ProviderInterest,
        RealtimeMapping,
    )
    from runtime_market_baseline import seed as baseline_seed
    from sqlalchemy import select, text

    schema = "runtime_topup"
    with storage.engine.begin() as db:
        db.execute(text(f"DROP SCHEMA IF EXISTS {schema} CASCADE"))
        db.execute(text(f"CREATE SCHEMA {schema}"))
    engine, factory, patch, ids, composite, revision, seam, stamp, target, inventory = (
        baseline_seed(schema, "normal"))
    storage.bootstrap(engine)
    with factory.begin() as db:
        # The baseline foreground interest points at a Binance dataset with no
        # reachable fixture; remove it and its dataset so provider polling is
        # driven only by the acceptance subscriptions below.
        interest = db.get(ProviderInterest, "baseline-foreground")
        if interest is not None:
            dataset_id = interest.dataset_id
            db.delete(interest)
            db.flush()
            dataset = db.get(ProviderDataset, dataset_id)
            if dataset is not None and not db.scalar(
                    select(ProviderInterest.id).where(
                        ProviderInterest.dataset_id == dataset_id)):
                db.delete(dataset)
        for name in ("BTCUSDT", "ETHUSDT", "EURUSD", "XAUUSD"):
            if db.get(Instrument, name):
                set_enabled(db, name, False, now=stamp)
        owner = db.get(PricingOwner, account_key(ACCOUNT))
        owner.token, owner.expires, owner.next_at, owner.error = None, 0, 0, None
        db.merge(Preference(key="runtime_topup_fixture",
                            value={"run": run, "synthetic": True}))
        # The composite revision is only an aggregate candidate while its source
        # dataset stays a managed realtime instrument; that is the same switch the
        # deployment uses for a composite-alert source.
        composite_row = db.get(MarketComposite, composite)
        revision_row = db.get(CompositeRevision, revision)
        target_row = db.get(RealtimeMapping, revision_row.mapping_id)
        target_instrument = db.get(MarketDataset, target_row.target_dataset_id).instrument_id
        set_enabled(db, target_instrument, True, now=stamp)
        if settings.oanda_acquisition_mode == "rest_batch":
            db.add(MarketDemand(id="acceptance-" + run,
                                instrument_id=composite_row.instrument_id,
                                composite_revision_id=revision,
                                expires=stamp + 3600000))
    control = {"run": run, "schema": schema, "business_origin": stamp,
               "monotonic_origin": time.monotonic(), "rules": ids,
               "rule_modes": inventory["rule_modes"], "composite": composite,
               "revision": revision, "target": target, "seam": seam,
               "calendar_version": settings.oanda_calendar_version,
               "synthetic": True}
    write(ROOT / "control.json", control)
    engine.dispose()
    patch.undo()
    print(json.dumps({"seeded": run, "schema": schema, "rules": len(ids),
                      "composite": composite, "revision": revision,
                      "synthetic": True}), flush=True)


# ----------------------------------------------------------------- supplier
def supplier(control):
    lock = threading.Lock()
    state = {"price": "1.110", "closes": {}, "hits": {}, "mode": "ok",
             "slow_hits": 0, "stub_deliveries": []}

    def hit(name, path):
        with lock:
            entry = state["hits"].setdefault(name, {"count": 0, "last": []})
            entry["count"] += 1
            entry["last"] = [*entry["last"][-39:], clock(control)]

    def body(at, complete=True):
        with lock:
            price = state["price"]
        return {"time": str(at / 1000), "complete": complete, "volume": 3,
                "bid": {"o": "1.100", "h": "1.120", "l": "1.090", "c": price},
                "ask": {"o": "1.101", "h": "1.121", "l": "1.091", "c": price},
                "mid": {"o": "1.1005", "h": "1.1205", "l": "1.0905", "c": price}}

    def candles(symbol, granularity, count, start_at, end_at):
        width = GRANULARITY_MS.get(granularity, 60000)
        end = end_at // width * width
        if start_at:
            start = start_at // width * width
            return [body(at) for at in range(start, min(end, start + 5000 * width), width)]
        return [body(end - (index + 1) * width) for index in reversed(range(min(count, 5000)))]

    def latest_candle(at, complete):
        with lock:
            price = state["price"] if not complete else state["closes"].get(at, state["price"])
        return {"time": str(at / 1000), "complete": complete, "volume": 3,
                "bid": {"o": "1.100", "h": "1.120", "l": "1.090", "c": price}}

    def quote():
        with lock:
            stamp, price = clock(control), state["price"]
        return {"type": "PRICE", "instrument": "EUR_USD", "time": str(stamp / 1000),
                "tradeable": True, "bids": [{"price": price}],
                "asks": [{"price": str(float(price) + .001)}]}

    class Handler(BaseHTTPRequestHandler):
        # HTTP/1.0 responses end at connection close, which the long-lived
        # pricing stream needs; the acceptance fixture is local and single-host.
        def log_message(self, *_args):
            pass

        def respond(self, value, status=200):
            body = json.dumps(value).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_HEAD(self):
            hit("head" + self.path, self.path)
            self.respond({})

        def do_POST(self):
            parsed = urlparse(self.path)
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            if parsed.path == SLOW_STUB:
                with lock:
                    state["slow_hits"] += 1
                time.sleep(120)
                self.respond({"blocked": True})
                return
            if parsed.path == "/stub/notification":
                value = json.loads(raw or b"{}")
                with lock:
                    state["stub_deliveries"].append({"at": clock(control), "body": value})
                self.respond({"id": "stub-" + str(len(state["stub_deliveries"]))})
                return
            if parsed.path == "/fixture/price":
                value = json.loads(raw or b"{}")
                if value.get("price") not in ("1.110", "1.119"):
                    self.send_error(400)
                    return
                with lock:
                    state["price"] = value["price"]
                    state["closes"][clock(control) // 60000 * 60000] = value["price"]
                self.respond({"price": value["price"], "at": clock(control)})
                return
            if parsed.path == "/fixture/mode":
                value = json.loads(raw or b"{}")
                with lock:
                    state["mode"] = value.get("mode", "ok")
                self.respond({"mode": state["mode"]})
                return
            self.send_error(404)

        def do_GET(self):
            parsed = urlparse(self.path)
            path, params = parsed.path, parse_qs(parsed.query)
            if path.startswith("/binance"):
                hit("binance" + path, path)
                self.respond({})
                return
            if path == SLOW_STUB or path.startswith(SLOW_STUB + "/"):
                with lock:
                    state["slow_hits"] += 1
                time.sleep(120)
                self.respond({"blocked": True})
                return
            if path == "/fixture/state":
                with lock:
                    self.respond({"price": state["price"], "mode": state["mode"],
                                  "hits": state["hits"], "slow_hits": state["slow_hits"],
                                  "stub_deliveries": state["stub_deliveries"],
                                  "at": clock(control), "synthetic": True})
                return
            if path in ("/", ""):
                hit("root", path)
                self.respond({})
                return
            if path == "/v3/accounts":
                self.respond({"accounts": [{"id": ACCOUNT}]})
                return
            if path.endswith("/summary"):
                self.respond({"account": {"id": ACCOUNT}})
                return
            if path.endswith("/instruments"):
                self.respond({"instruments": [
                    {"name": "EUR_USD", "displayName": "Fixture EUR/USD", "displayPrecision": 5},
                    {"name": "XAU_USD", "displayName": "Fixture XAU/USD", "displayPrecision": 3}]})
                return
            if path.endswith("/candles/latest"):
                hit("candles_latest", path)
                at = clock(control) // 60000 * 60000
                self.respond({"latestCandles": [{"instrument": "EUR_USD",
                              "granularity": "M1",
                              "candles": [latest_candle(at - 60000, True),
                                          latest_candle(at, False)]}]})
                return
            if "/instruments/" in path and path.endswith("/candles"):
                symbol = path.split("/instruments/")[1].split("/")[0]
                granularity = (params.get("granularity") or ["M1"])[0]
                hit("candles:" + symbol + ":" + granularity, path)
                if state["mode"] == "timeout":
                    time.sleep(120)
                count = min(int((params.get("count") or ["3"])[0]), 4000)
                end_at = int(float((params.get("to") or ["0"])[0]) * 1000) or clock(control)
                start_at = int(float(params["from"][0]) * 1000) if params.get("from") else 0
                self.respond({"instrument": symbol, "granularity": granularity,
                              "candles": candles(symbol, granularity, count, start_at, end_at)})
                return
            if path.endswith("/pricing/stream"):
                hit("pricing_stream", path)
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
            if path.endswith("/pricing"):
                hit("pricing", path)
                self.respond({"prices": [quote()]})
                return
            hit("unknown:" + path, path)
            self.send_error(404)

    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()


# ---------------------------------------------------------------- transport
def fixture_transport():
    """Rewrite provider/stream destinations to the local fixture supplier."""
    import httpx
    from alerts.provider_deadline import DeadlineBackend

    class Fixture(httpx.HTTPTransport):
        ROUTES = {"api-fxpractice.oanda.com": "",
                  "stream-fxpractice.oanda.com": "",
                  "data-api.binance.vision": "/binance",
                  "freeserv.dukascopy.com": SLOW_STUB}

        def handle_request(self, request):
            prefix = self.ROUTES.get(request.url.host)
            if prefix is None:
                raise ValueError("Unexpected fixture destination: " + request.url.host)
            request.url = request.url.copy_with(scheme="http", host=SUPPLIER, port=8080,
                                                path=prefix + request.url.path)
            request.headers["host"] = SUPPLIER + ":8080"
            return super().handle_request(request)

    def make(*, proxy=None, limits=None):
        options = {"proxy": proxy, "trust_env": False}
        if limits is not None:
            options["limits"] = limits
        transport = Fixture(**options)
        transport._pool._network_backend = DeadlineBackend(transport._pool._network_backend)
        return transport

    return make


def patch_runtime_io():
    from alerts import oanda_worker, provider_transport
    from alerts.oanda_rest_batch import OandaRestBatch
    from alerts.oanda_stream import OandaPractice
    import httpx

    make = fixture_transport()
    provider_transport.deadline_transport = make

    class FixtureClients:
        def __init__(self, **kwargs):
            rest = httpx.Client(transport=make(proxy=None, limits=None), timeout=5)
            stream = httpx.Client(transport=make(proxy=None, limits=None), timeout=5)
            kwargs.update(rest_client=rest, stream_client=stream, clock=lambda: clock(CONTROL))
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


CONTROL = {}


# ------------------------------------------------------------------ runtime
def runtime(profile, fault=None, slow_delivery=False):
    patch_runtime_io()
    if profile == "notifications" and slow_delivery:
        return runtime_slow_delivery()
    if fault:
        from alerts import market_runtime
        from alerts.runtime_health import progress
        from alerts.runtime_supervisor import Loop

        original = market_runtime.build_loops

        def injected(stop):
            progress()
            if fault == "exception":
                stop.wait(5)
                raise RuntimeError("Controlled acceptance loop failure")
            stop.wait()

        market_runtime.build_loops = lambda: tuple(
            Loop(loop.role, injected) if loop.role == "composite_aggregate" else loop
            for loop in original())
    from alerts.runtime import main

    sys.argv = ["alerts.runtime", "--profile", profile]
    main()


def runtime_slow_delivery():
    """Real notification group with only the delivery HTTP destination replaced.

    The environment keeps ALERTS_DELIVERY_ENABLED=false and no topic. The probe
    sets the topic in-process and points the delivery client at a local stub that
    never answers, then runs the same three supervised roles.
    """
    import httpx
    from alerts import notification_center_worker, notification_runtime, notify
    from alerts.config import settings
    from alerts.runtime_supervisor import Loop

    settings.ntfy_topic = "stage5-topup-stub"
    settings.ntfy_url = "http://" + SUPPLIER + ":8080" + SLOW_STUB
    # The delivery destination is already the local stub, so no destination
    # rewrite is needed; a plain client keeps the real httpx timeout semantics.
    client = httpx.Client(timeout=20, trust_env=False)
    loops = (
        Loop("notification_projection", notification_center_worker.run_projection),
        Loop("notification_retention", notification_center_worker.run_retention),
        Loop("notification_delivery", lambda stop: notify.run(stop, client=client)),
    )
    notification_runtime.run(loops=loops)


def api():
    import uvicorn

    uvicorn.run("alerts.api:app", host="0.0.0.0", port=8000)


# --------------------------------------------------------------- snapshots
def snapshot(label):
    from alerts import runtime_health
    from alerts.config import settings
    from alerts.live_pricing import account_key
    from alerts.storage import (
        Audit,
        ChartAlert,
        ChartAlertVersion,
        CompositeAggregateTask,
        CompositeRevision,
        DeliveryAttempt,
        LiveState,
        MarketDemand,
        Notification,
        Outbox,
        Preference,
        PricingOwner,
        ProviderBar,
        ProviderDataset,
        ProviderInterest,
        Session,
        SignalRow,
    )
    from sqlalchemy import func, select

    deployment = settings.runtime_deployment
    prefix = "worker_health:runtime:" + deployment + ":"
    with Session() as db:
        roles = {}
        for row in db.scalars(select(Preference).where(
                Preference.key.startswith(prefix, autoescape=True))).all():
            value = dict(row.value)
            checked = value.get("checked_at")
            stale_after = value.get("stale_after_ms", 15000)
            stamp = clock(CONTROL)
            state = value.get("state")
            if checked is None:
                state = "stale" if stamp - value.get("started_at", 0) >= 60000 else state
            elif stamp - checked >= stale_after:
                state = "stale"
            roles[value.get("role") or row.key.removeprefix(prefix)] = {
                "group": value.get("group"), "state": state, "stored_state": value.get("state"),
                "boot_id": value.get("boot_id"), "checked_at": checked,
                "started_at": value.get("started_at"), "error_type": value.get("error_type"),
                "watermark": value.get("watermark"), "starts": len(value.get("starts") or []),
                "stale_after_ms": stale_after}
        source = db.get(LiveState, CONTROL["target"])
        owner = db.get(PricingOwner, account_key(ACCOUNT))
        tasks = {}
        for rev in db.scalars(select(CompositeRevision.id)).all():
            for frame in ("M1", "M5", "H1"):
                task = db.get(CompositeAggregateTask, (rev, frame))
                if task is not None:
                    tasks[str(rev) + ":" + frame] = {"applied": task.applied_input_revision,
                                                    "lease_token": task.lease_token,
                                                    "lease_until": task.lease_until}
        interests = [{"id": row.id, "client": row.client, "dataset": row.dataset_id,
                      "subscribed": row.subscribed, "expires": row.expires,
                      "error": row.error, "revision": row.revision,
                      "next_poll": row.next_poll}
                     for row in db.scalars(select(ProviderInterest)).all()]
        datasets = []
        for row in db.scalars(select(ProviderDataset)).all():
            bars = db.scalar(select(func.count()).select_from(ProviderBar).where(
                ProviderBar.dataset_id == row.id))
            datasets.append({"id": row.id, "source": row.source, "frame": row.timeframe,
                             "revision": row.revision, "updated_at": row.updated_at,
                             "accessed_at": row.accessed_at, "bars": bars,
                             "lease_until": row.lease_until})
        rules = []
        for row in db.scalars(select(ChartAlert).where(
                ChartAlert.id.in_(CONTROL["rules"]))).all():
            version = db.scalar(select(ChartAlertVersion).where(
                ChartAlertVersion.alert_id == row.id,
                ChartAlertVersion.version == row.version))
            rules.append({"id": row.id, "health": row.health, "reason": row.health_reason,
                          "status": row.status, "count": row.count, "runtime": row.runtime,
                          "state": row.state, "dataset": version.dataset_id if version else None})
        signals = [{"id": row.id, "rule": row.chart_alert_id, "occurred_at": row.occurred_at}
                   for row in db.scalars(select(SignalRow).order_by(SignalRow.id)).all()]
        notifications = [{"id": row.id, "signal": row.signal_id, "kind": row.kind,
                          "status": row.status, "ack_at": row.ack_at,
                          "created_at": row.created_at}
                         for row in db.scalars(select(Notification).order_by(
                             Notification.created_at)).all()]
        outbox = [{"id": row.id, "notification": row.notification_id, "status": row.status,
                   "attempts": row.attempts, "lease_until": row.lease_until,
                   "next_at": row.next_at, "error": row.error}
                  for row in db.scalars(select(Outbox).order_by(Outbox.next_at)).all()]
        attempts = [{"id": row.id, "notification": row.notification_id, "status": row.status,
                     "at": row.at, "details": row.details}
                    for row in db.scalars(select(DeliveryAttempt).order_by(
                        DeliveryAttempt.at)).all()]
        audits = {}
        for row in db.scalars(select(Audit).where(
                Audit.kind.in_(("notify_heartbeat", "notification_test_accepted",
                                "notification_test_failed_or_unknown",
                                "notification_test_requested")))).all():
            audits[row.kind] = audits.get(row.kind, 0) + 1
        demand = [{"id": row.id, "instrument": row.instrument_id,
                   "revision": row.composite_revision_id, "expires": row.expires}
                  for row in db.scalars(select(MarketDemand)).all()]
        incidents = {row.key.removeprefix("runtime_incident:"): row.value
                     for row in db.scalars(select(Preference).where(
                         Preference.key.startswith("runtime_incident:"))).all()}
        business_now = clock(CONTROL)
        value = {
            "label": label, "synthetic": True, "deployment": deployment,
            "business_at": business_now, "monotonic": time.monotonic(),
            "session": session_states(), "roles": roles,
            "source": None if source is None else {
                "ready": source.ready, "epoch": source.epoch,
                "owner_valid": bool(owner and owner.token and owner.expires > business_now
                                    and owner.epoch == source.epoch),
                "revision": source.revision, "confirmed_end": source.confirmed_end,
                "received_age_ms": business_now - source.received_at},
            "aggregate_tasks": tasks, "interests": interests, "datasets": datasets,
            "rules": rules, "signals": signals, "notifications": notifications,
            "outbox": outbox, "delivery_attempts": attempts, "audits": audits,
            "demand": demand, "incidents": incidents,
        }
    write(ROOT / ("snapshot-" + label + ".json"), value)
    print(json.dumps({
        "label": label, "business_at": value["business_at"],
        "roles": {role: {"state": row["state"], "error": row["error_type"],
                         "boot": (row["boot_id"] or "")[:8]}
                  for role, row in value["roles"].items()},
        "source": value["source"], "interests": len(value["interests"]),
        "signals": len(value["signals"]), "notifications": len(value["notifications"]),
        "outbox": {status: sum(1 for row in value["outbox"] if row["status"] == status)
                   for status in {row["status"] for row in value["outbox"]}},
        "incidents": sorted(value["incidents"]),
    }, ensure_ascii=False), flush=True)


def session_states():
    from alerts.market_calendar import session_status

    now = clock(CONTROL)
    weekday = datetime.fromtimestamp(now / 1000, timezone.utc).weekday()
    weekend = now + ((5 - weekday) % 7) * 86400000
    # OANDA EUR/USD has no verified acceptance calendar profile in this fixture;
    # the versioned built-in registry does verify Dukascopy XAU/USD, so that rule
    # supplies the real closed/open representation at container level.
    real = int(time.time() * 1000)
    real_weekday = datetime.fromtimestamp(real / 1000, timezone.utc).weekday()
    real_weekend = real + ((5 - real_weekday) % 7) * 86400000
    return {"oanda_eurusd": session_status(
                "oanda", "EUR_USD", now,
                metadata={"calendar_version": CONTROL["calendar_version"]}),
            "fixture_weekend_dukascopy": session_status("dukascopy", "XAU/USD", weekend,
                                                        metadata={}),
            "real_now_dukascopy": session_status("dukascopy", "XAU/USD", real, metadata={}),
            "real_weekend_dukascopy": session_status("dukascopy", "XAU/USD", real_weekend,
                                                     metadata={}),
            "real_now": real, "real_weekend": real_weekend}


# ----------------------------------------------------------- browser charts
def oanda_native_meta(symbol="EUR_USD", ident="OANDA:EUR_USD"):
    """The provider identity the platform chart metadata returns for an OANDA pair."""
    from alerts.chart_data import FRAMES
    from alerts.config import settings
    from alerts.native_series import DEFAULTS

    return {"id": ident, "display_symbol": symbol, "symbol": symbol, "name": "Fixture " + symbol,
            "source": "oanda", "basis": "bid", "calendar": "ny17", "precision": 5,
            "frames": FRAMES, "series_kind": "provider", "native_parameters": dict(DEFAULTS),
            "calendar_version": settings.oanda_calendar_version}


def chart(action):
    """Browser-side low-frequency provider subscription, through the real cache API."""
    from alerts import provider_cache, provider_service
    from alerts.storage import ProviderInterest, Session, now_ms

    client, listener, ident = "chart-browser-a", "chart-a", "acceptance-chart-h1"
    meta = oanda_native_meta()
    key = provider_cache.ensure(meta, "H1")
    if action == "on":
        with Session.begin() as db:
            row = db.get(ProviderInterest, ident)
            values = dict(dataset_id=key, subscribed=True, expires=now_ms() + 30000,
                          accessed_at=now_ms(), cursor=0, revision=0, targets=[],
                          next_poll=0, error=None, indicators=[])
            if row is None:
                db.add(ProviderInterest(id=ident, client=client, listener=listener, **values))
            else:
                for field, value in values.items():
                    setattr(row, field, value)
        print(json.dumps({"subscribed": {"id": ident, "dataset": key}}), flush=True)
    elif action == "tick":
        provider_service.renew(client)
        with Session() as db:
            row = db.get(ProviderInterest, ident)
            value = {"expires": row.expires, "subscribed": row.subscribed} if row else None
        print(json.dumps({"renewed": client, "interest": value}), flush=True)
    elif action == "off":
        with Session.begin() as db:
            row = db.get(ProviderInterest, ident)
            if row is not None:
                db.delete(row)
        print(json.dumps({"unsubscribed": client}), flush=True)
    else:
        raise ValueError(action)


def slow_source(action):
    """Create/remove a Dukascopy interest whose origin maps to a non-answering stub."""
    from alerts import provider_cache
    from alerts.storage import ProviderInterest, Session, now_ms

    client, listener = "chart-slow-source", "dukascopy-slow"
    meta = {"id": "DUKA:SLOWFIXTURE", "source": "dukascopy", "symbol": "SLOWFIXTURE",
            "basis": "bid", "calendar": "utc0", "precision": 5, "label": "Slow fixture",
            "frames": ("M1", "M5", "M15", "M30", "H1", "H4", "D1")}
    if action == "on":
        key = provider_cache.ensure(meta, "H1")
        with Session.begin() as db:
            row = db.get(ProviderInterest, "acceptance-slow-source")
            if row is None:
                db.add(ProviderInterest(id="acceptance-slow-source", client=client,
                                        listener=listener, dataset_id=key, subscribed=True,
                                        expires=now_ms() + 3600000, accessed_at=now_ms(),
                                        targets=[], indicators=[], next_poll=0))
        print(json.dumps({"slow_interest": "acceptance-slow-source", "dataset": key}), flush=True)
    elif action == "off":
        with Session.begin() as db:
            row = db.get(ProviderInterest, "acceptance-slow-source")
            if row is not None:
                db.delete(row)
        print(json.dumps({"slow_interest": None}), flush=True)
    else:
        raise ValueError(action)


def price(value):
    import httpx

    response = httpx.post("http://" + SUPPLIER + ":8080/fixture/price", json={"price": value})
    response.raise_for_status()
    print(json.dumps({"price": value}), flush=True)


def supplier_state():
    import httpx

    response = httpx.get("http://" + SUPPLIER + ":8080/fixture/state")
    response.raise_for_status()
    value = response.json()
    write(ROOT / "supplier-state.json", value)
    print(json.dumps({"price": value["price"], "mode": value["mode"],
                      "hits": {key: hits["count"] for key, hits in value["hits"].items()},
                      "slow_hits": value["slow_hits"],
                      "stub_deliveries": len(value["stub_deliveries"])}), flush=True)


def wait_provider_quiet(seconds, key_contains="candles:EUR_USD:H1"):
    import httpx

    def hits():
        value = httpx.get("http://" + SUPPLIER + ":8080/fixture/state").json()
        return value["hits"].get(key_contains, {"count": 0, "last": []})

    before = hits()
    time.sleep(seconds)
    after = hits()
    value = {"key": key_contains, "window_s": seconds, "before": before, "after": after,
             "quiet": before["count"] == after["count"], "synthetic": True}
    write(ROOT / "provider-quiet.json", value)
    print(json.dumps({"key": key_contains, "window_s": seconds,
                      "before": before["count"], "after": after["count"],
                      "quiet": value["quiet"]}), flush=True)


# --------------------------------------------------- notification fixtures
def test_notifications(count):
    from alerts.storage import Notification, Outbox, Preference, now_ms, transaction

    created = []
    with transaction() as db:
        for index in range(count):
            test_id = "topup-" + str(index) + "-" + str(now_ms())
            note = Notification(kind="test", signal_id=None, status="pending", payload={
                "test_id": test_id,
                "title": "守望 · 投递阻塞验收",
                "message": "本地 stub 投递，仅用于验收，不是真实通知。",
                "test_authorized": True})
            db.add(note)
            db.flush()
            db.add(Outbox(notification_id=note.id, status="pending", attempts=0,
                          next_at=now_ms(), lease_until=None, error=None, provider_id=None))
            # Same durable test identity the API writes before an outbox claim.
            db.add(Preference(key="test_notification:" + test_id,
                              value={"notification_id": note.id, "ack_at": None,
                                     "expires": now_ms() + 86400000}))
            created.append(note.id)
    print(json.dumps({"test_notifications": len(created), "ids": created}), flush=True)


def notify_claim(action):
    """Exercise the real claim/delivery path against a local stub only."""
    import httpx
    from alerts import notify
    from alerts.config import settings

    settings.ntfy_topic = "stage5-topup-stub"
    settings.ntfy_url = "http://" + SUPPLIER + ":8080" + SLOW_STUB
    if action == "deliver-blocked":
        client = httpx.Client(timeout=20, trust_env=False)
        started = time.monotonic()
        claimed = notify.claim()
        value = {"claimed": claimed is not None, "claim_s": time.monotonic() - started}
        if claimed:
            value.update(task=claimed[0], note=claimed[1], attempt=claimed[3])
            started = time.monotonic()
            notify.deliver_once(client)
            value["delivery_s"] = time.monotonic() - started
        value["synthetic"] = True
        write(ROOT / "delivery-blocked.json", value)
        print(json.dumps(value), flush=True)
        return
    claimed = notify.claim()
    value = {"claimed": claimed is not None,
             "attempt": None if claimed is None else claimed[3],
             "task": None if claimed is None else claimed[0]}
    write(ROOT / ("notify-" + action + ".json"), value)
    print(json.dumps(value), flush=True)


def projection_watch(seconds):
    """Sample the notification roles while a delivery attempt blocks."""
    from alerts.config import settings
    from alerts.storage import Preference, Session

    keys = {role: "worker_health:runtime:" + settings.runtime_deployment + ":" + role
            for role in ("notification_projection", "notification_retention",
                         "notification_delivery")}
    samples = []
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        with Session() as db:
            row = {"at": round(time.monotonic(), 3)}
            for role, key in keys.items():
                stored = db.get(Preference, key)
                value = dict(stored.value) if stored else {}
                row[role] = {"checked_at": value.get("checked_at"),
                             "state": value.get("state"),
                             "error": value.get("error_type")}
            samples.append(row)
        time.sleep(2)
    value = {"samples": samples, "synthetic": True}
    write(ROOT / "projection-watch.json", value)
    print(json.dumps({"samples": len(samples),
                      "first": samples[0] if samples else None,
                      "last": samples[-1] if samples else None}), flush=True)


def rules(action):
    from alerts.chart_alert_service import lifecycle
    from alerts.storage import ChartAlert, Session, now_ms

    with Session.begin() as db:
        for ident in CONTROL["rules"]:
            row = db.get(ChartAlert, ident)
            if row is None:
                continue
            lifecycle(db, ident, row.version, action,
                      expected_revision=row.control_revision,
                      request_id="topup-" + action + "-" + ident + "-" + str(now_ms()),
                      at=now_ms())
    print(json.dumps({"rules": action, "count": len(CONTROL["rules"])}), flush=True)


# -------------------------------------------------- instance-replacement fence
def fence_old(seconds):
    from alerts import runtime_health
    from alerts.storage import Preference, Session

    boot = runtime_health.boot()
    reporter = runtime_health.Progress("market", "composite_aggregate", boot)
    reporter.claim()
    started = time.monotonic()
    while time.monotonic() - started < seconds:
        reporter.record(state="idle")
        time.sleep(2)
    late = None
    try:
        reporter.record(state="failed", error=RuntimeError("late old-instance write"))
        late = "record-not-raised"
    except Exception as error:  # pragma: no cover - defensive
        late = type(error).__name__
    with Session() as db:
        stored = dict(db.get(Preference, runtime_health.key("composite_aggregate")).value)
    result = {"boot": boot, "old_write_result": late, "stored_boot": stored.get("boot_id"),
              "stored_state": stored.get("state"), "stored_error": stored.get("error_type"),
              "same_boot": stored.get("boot_id") == boot, "synthetic": True}
    write(ROOT / "fence-old.json", result)
    print(json.dumps(result), flush=True)


def fence_new(delay, seconds):
    from alerts import runtime_health
    from alerts.storage import Preference, Session

    time.sleep(delay)
    boot = runtime_health.boot()
    reporter = runtime_health.Progress("market", "composite_aggregate", boot)
    reporter.claim()
    samples = []
    started = time.monotonic()
    while time.monotonic() - started < seconds:
        reporter.record(state="idle")
        stamp = CONTROL["business_origin"] + int(
            (time.monotonic() - CONTROL["monotonic_origin"]) * 1000)
        with Session() as db:
            stored = dict(db.get(Preference, runtime_health.key("composite_aggregate")).value)
            summary = {row["role"]: row["state"] for row in runtime_health.summary(
                db, runtime_health.MARKET_ROLES, at=stamp)}
            samples.append({"at": round(time.monotonic(), 3),
                            "boot": stored.get("boot_id"), "state": stored.get("state"),
                            "error": stored.get("error_type"),
                            "summary": summary.get("composite_aggregate")})
        time.sleep(2)
    result = {"boot": boot, "samples": samples, "synthetic": True}
    write(ROOT / "fence-new.json", result)
    print(json.dumps({"boot": boot, "samples": len(samples),
                      "states": sorted({(row["state"], row["error"]) for row in samples}, key=str),
                      "summary_states": sorted({row["summary"] for row in samples})}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=(
        "seed", "supplier", "runtime", "api", "snapshot", "chart", "slow-source",
        "price", "supplier-state", "provider-quiet", "test-notifications",
        "notify", "projection-watch", "rules", "fence-old", "fence-new"))
    parser.add_argument("--profile", choices=("market", "alert", "data", "notifications"),
                        default="market")
    parser.add_argument("--fault", choices=("exception", "stuck"))
    parser.add_argument("--slow-delivery", action="store_true")
    parser.add_argument("--label", default="status")
    parser.add_argument("--phase", default="on")
    parser.add_argument("--value", default="1.119")
    parser.add_argument("--count", type=int, default=1)
    parser.add_argument("--seconds", type=float, default=30)
    parser.add_argument("--delay", type=float, default=10)
    args = parser.parse_args()
    run = os.environ.get("MW_TOPUP_RUN", "")
    parsed = urlparse(os.environ.get("ALERTS_DATABASE_URL", ""))
    if (not re.fullmatch(r"[a-z][a-z0-9_]{0,36}", run) or parsed.hostname != "postgres"
            or parsed.path != "/runtime_profile"
            or os.environ.get("ALERTS_DELIVERY_ENABLED") != "false"
            or os.environ.get("ALERTS_NTFY_TOPIC")):
        raise RuntimeError("Only the isolated runtime_profile task database is allowed")
    query = parse_qs(parsed.query)
    query["options"] = ["-csearch_path=runtime_topup"]
    os.environ["ALERTS_DATABASE_URL"] = urlunparse(
        parsed._replace(query=urlencode(query, doseq=True)))
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    if args.action == "seed":
        seed(run)
        return
    CONTROL.update(json.loads((ROOT / "control.json").read_text()))
    configure(CONTROL)
    if args.action == "supplier":
        supplier(CONTROL)
    elif args.action == "runtime":
        runtime(args.profile, args.fault, args.slow_delivery)
    elif args.action == "api":
        api()
    elif args.action == "snapshot":
        snapshot(args.label)
    elif args.action == "chart":
        chart(args.phase)
    elif args.action == "slow-source":
        slow_source(args.phase)
    elif args.action == "price":
        price(args.value)
    elif args.action == "supplier-state":
        supplier_state()
    elif args.action == "provider-quiet":
        wait_provider_quiet(args.seconds)
    elif args.action == "test-notifications":
        test_notifications(args.count)
    elif args.action == "notify":
        notify_claim(args.phase)
    elif args.action == "projection-watch":
        projection_watch(args.seconds)
    elif args.action == "rules":
        rules(args.phase)
    elif args.action == "fence-old":
        fence_old(args.seconds)
    elif args.action == "fence-new":
        fence_new(args.delay, args.seconds)


if __name__ == "__main__":
    main()

