"""Task-owned synthetic prices and notification sink for Ubuntu acceptance."""

import argparse
import hashlib
import json
import os
import subprocess
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

TASK = "mw-price-alerts-v203rc1"
ACCOUNT = "price-alerts-v203rc1-fixture"
SYMBOLS = ("EUR_USD", "GBP_USD", "AUD_USD", "NZD_USD", "USD_JPY", "USD_CHF",
           "USD_CAD", "EUR_GBP", "EUR_JPY", "GBP_JPY")
MARKER = "acceptance:" + TASK
MINUTE = 60000


def write_json(path, data):
    scratch = path.with_suffix(".tmp")
    with os.fdopen(os.open(scratch, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as out:
        json.dump(data, out, ensure_ascii=False, indent=2)
        out.write("\n")
    scratch.replace(path)


def read_control(root):
    path = root / "control.json"
    return json.loads(path.read_text()) if path.exists() else {}


def setup_host(path):
    cfg = json.loads(path.read_text())
    url = urlsplit(cfg["database_url"])
    if (cfg["project"] != TASK or url.hostname != "127.0.0.1"
            or url.port != cfg["pg_port"] or url.path != "/price_alerts"
            or url.username != "price_alerts" or url.query
            or cfg["web_url"] != "http://127.0.0.1:28463"):
        raise SystemExit("Refusing an unowned acceptance target")
    container = json.loads(subprocess.check_output(
        ["docker", "inspect", TASK + "-postgres-1"], text=True))[0]
    labels = container["Config"]["Labels"]
    bindings = container["NetworkSettings"]["Ports"]["5432/tcp"]
    if (labels.get("com.docker.compose.project") != TASK
            or labels.get("com.docker.compose.service") != "postgres"
            or not container["State"]["Running"]
            or bindings != [{"HostIp": "127.0.0.1", "HostPort": str(url.port)}]):
        raise SystemExit("Refusing a database outside the task's PostgreSQL container")
    os.environ.update(ALERTS_DATABASE_URL=cfg["database_url"], ALERTS_DATABASE_EXPECTED_VERSION="140024",
                      ALERTS_DATABASE_JIT="off", ALERTS_RUNTIME_DEPLOYMENT=TASK,
                      ALERTS_OANDA_ACCOUNT_ID=ACCOUNT, ALERTS_OANDA_TOKEN="local-fixture-not-a-provider-token",
                      ALERTS_OANDA_RESIDENT_SYMBOLS="", ALERTS_DELIVERY_ENABLED="true",
                      ALERTS_NTFY_TOPIC=cfg["topic"])
    return path.parent / "controls"


def check_runtime():
    from alerts.config import settings
    from sqlalchemy.engine import make_url

    url = make_url(settings.database_url)
    if (settings.runtime_deployment != TASK or settings.oanda_account_id != ACCOUNT
            or settings.ntfy_url != "http://notification-fixture:8080"
            or (url.host, url.port, url.database, url.username) != ("postgres", 5432, "price_alerts", "price_alerts")):
        raise SystemExit("Fixture only runs in the owned isolated Compose project")


def candle_batch(identity, start, end, price, stamp):
    from alerts.market_contracts import CandleBatch, MinuteRow, RequestResult

    live = identity.source == "oanda"
    rows = tuple(MinuteRow(timestamp=at, open=price, high=price, low=price, close=price,
                           volume="4", complete=True) for at in range(start, end, MINUTE))
    return CandleBatch(identity=identity, window_start=start, window_end=end, observed_at=stamp,
        result=RequestResult(status="data"), rows=rows, checkpoint=end,
        volume_kind="price_count" if live else "quantity", volume_unit="quotes" if live else "source_quantity")


class HistoryFixture:
    def page(self, identity, start, end):
        from alerts.storage import now_ms

        return candle_batch(identity, start, end, "99", now_ms())


def seed(root, count):
    from alerts.composite_definitions import first_use, save_mapping
    from alerts.composite_series import period
    from alerts.history_artifacts import artifact_tick
    from alerts.history_catalog import account_scope
    from alerts.history_versions import create_version, import_page
    from alerts.market_contracts import DatasetIdentity
    from alerts.market_datasets import register_dataset
    from alerts.realtime_switch import set_enabled
    from alerts.storage import MarketCatalog, Preference, now_ms, transaction

    stamp = now_ms()
    seam, _ = period(stamp - 180000, "D1", "ny17")
    entries = {}
    for symbol in SYMBOLS[:count]:
        base, quote = symbol.split("_")
        historical = DatasetIdentity(source="dukascopy", channel="python", environment="historical",
            account_scope="public", provider_symbol=base + "/" + quote, basis="bid",
            calendar_version="candidate-ny17-v1")
        catalog_id = "HC:" + hashlib.sha256(symbol.encode()).hexdigest()[:36]
        with transaction() as db:
            old = db.get(Preference, MARKER + ":" + symbol)
            if old:
                entries[symbol] = old.value
                continue
            inst = register_dataset(db, historical, logical_symbol=base + quote, label="FIXTURE " + symbol,
                calendar="ny17", precision=5, volume_kind="quantity", volume_unit="source_quantity")
            instrument_id = inst.id
            version = create_version(db, historical.key, seam - 180 * MINUTE, seam + MINUTE)
            db.add(MarketCatalog(id=catalog_id, source="oanda", symbol=symbol, label="FIXTURE " + symbol,
                asset_type="CURRENCY", precision=5, calendar="ny17",
                metadata_json={"history_account_scope": account_scope()}))
        if not import_page(HistoryFixture(), version_id=version):
            raise RuntimeError("Fixture history import did not advance")
        while artifact_tick(version):
            pass
        with transaction() as db:
            proof = {"underlying": base, "quote_currency": quote, "historical_product": "spot_fx",
                "live_product": "spot_fx", "relationship": "same_product", "reviewed": True,
                "historical_evidence": "https://fixture.invalid/history",
                "live_evidence": "https://fixture.invalid/live",
                "rationale": "Synthetic fixture; both lanes have the same bid price identity."}
            mapping = save_mapping(db, historical.key, catalog_id, proof)
            composite = first_use(db, historical.key, mapping.id)
            set_enabled(db, instrument_id, True, now=stamp)
            entries[symbol] = {"composite_id": composite.id, "revision_id": composite.active_revision_id,
                               "dataset_id": mapping.target_dataset_id}
            db.add(Preference(key=MARKER + ":" + symbol, value=entries[symbol]))
    root.mkdir(exist_ok=True)
    write_json(root / "control.json", {"entries": entries, "price": "99", "online": True,
        "prime_until": stamp + 600000})
    return {"project": TASK, "synthetic": True, "entries": entries}


def fixture_pricing(stop):
    from alerts import live_pricing, runtime_health
    from alerts.market_contracts import DatasetIdentity, QuoteEvent, RequestResult
    from alerts.storage import MarketDataset, now_ms, transaction

    root = Path("/controls")
    owned, identities, epoch, seq, cutoff = None, {}, 0, 0, 0
    while not stop.is_set():
        cfg = read_control(root)
        stamp = now_ms()
        allowed = cfg.get("entries", {})
        wanted = {}
        if cfg.get("online"):
            if stamp < cfg.get("prime_until", 0):
                with transaction() as db:
                    wanted = {name: DatasetIdentity.model_validate(db.get(MarketDataset, item["dataset_id"]).identity)
                              for name, item in allowed.items()}
            else:
                wanted = {name: value for name, value in live_pricing.desired_datasets(ACCOUNT).items()
                          if name in allowed and value.key == allowed[name]["dataset_id"]}
        if owned and wanted != identities:
            live_pricing.disconnected(owned, epoch, identities, RequestResult(status="unavailable"),
                                      intentional=bool(cfg.get("online")))
            owned, identities = None, {}
        if wanted and not owned:
            owned = live_pricing.claim(ACCOUNT)
            if owned:
                identities = wanted
                epoch = live_pricing.begin_connection(owned, identities)
                cutoff = 0
                seq = 0
        if owned:
            next_cutoff = live_pricing.confirmation_cutoff(stamp)
            if next_cutoff > cutoff:
                for value in identities.values():
                    source = candle_batch(value, max(cutoff, next_cutoff - 5 * MINUTE),
                                          next_cutoff, cfg.get("close_price", "99"), stamp)
                    live_pricing.commit_confirmation(owned, epoch, source)
                cutoff = next_cutoff
            for value in identities.values():
                seq += 1
                stamp = now_ms()
                price = cfg["price"]
                live_pricing.publish_event(owned, epoch, QuoteEvent(identity=value, bid=price, ask=price,
                    source_time=stamp, received_at=stamp, tradeable=True, connection_epoch=epoch,
                    sequence=seq), identities)
        runtime_health.progress(state="running" if owned else "idle")
        stop.wait(0.5)


def market():
    from alerts.market_runtime import build_loops, run
    from alerts.runtime_supervisor import Loop

    check_runtime()
    run(loops=tuple(Loop("pricing", fixture_pricing) if loop.role == "pricing" else loop
                    for loop in build_loops()))


def notification():
    from alerts.config import settings

    check_runtime()

    class Sink(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            size = int(self.headers.get("Content-Length", 0))
            if self.path != "/" or not 0 < size <= 32768:
                self.send_error(400)
                return
            body = json.loads(self.rfile.read(size))
            if body.get("topic") != settings.ntfy_topic:
                self.send_error(403)
                return
            status = read_control(Path("/controls")).get("notification_response", 200)
            if status == "timeout":
                time.sleep(17)
                return
            raw = b'{"id":"local-fixture"}'
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

    ThreadingHTTPServer(("0.0.0.0", 8080), Sink).serve_forever()


def evidence(alert_id):
    from alerts.storage import Audit, ChartAlert, MarketDemand, SignalRow, now_ms, transaction
    from sqlalchemy import func, select

    with transaction() as db:
        alert = db.get(ChartAlert, alert_id)
        signals = db.scalars(select(SignalRow).where(SignalRow.chart_alert_id == alert_id)
                             .order_by(SignalRow.occurred_at)).all()
        transitions = db.scalars(select(Audit).where(Audit.kind == "chart_alert_execution",
            Audit.details["alert_id"].as_string() == alert_id).order_by(Audit.id)).all()
        charts = db.scalar(select(func.count()).select_from(MarketDemand).where(MarketDemand.expires > now_ms()))
        return {"id": alert.id, "status": alert.status, "count": alert.count, "runtime": alert.runtime,
            "unexpired_chart_leases": charts,
            "events": [{"id": row.id, "price": str(row.price), "occurred_at": row.occurred_at,
                        "detected_at": row.created_at} for row in signals],
            "transitions": [row.details for row in transitions]}


def percent95(values):
    return sorted(values)[(95 * len(values) + 99) // 100 - 1] if values else None


def perf_worker(root, seconds):
    """Use the real collector and monitor with 50 rules and controlled time of arrivals."""
    import resource
    import threading

    from alerts import live_pricing
    from alerts.alert_monitor import run
    from alerts.chart_alert_service import AlertConfig, create
    from alerts.composite_aggregates import aggregate_tick
    from alerts.market_contracts import DatasetIdentity, QuoteEvent
    from alerts.storage import ChartAlert, MarketDataset, SignalRow, bootstrap, now_ms, transaction
    from sqlalchemy import func, select, text

    bootstrap()
    entries = seed(root, 10)["entries"]
    with transaction() as db:
        identities = {key: DatasetIdentity.model_validate(db.get(MarketDataset, row["dataset_id"]).identity)
                      for key, row in entries.items()}
    owned = live_pricing.claim(ACCOUNT)
    assert owned is not None
    epoch = live_pricing.begin_connection(owned, identities)
    assert epoch > 0
    seq = 0
    for identity in identities.values():
        stamp = now_ms()
        cutoff = live_pricing.confirmation_cutoff(stamp)
        live_pricing.commit_confirmation(owned, epoch, candle_batch(
            identity, cutoff - 5 * MINUTE, cutoff, "99", stamp))
        seq += 1
        live_pricing.publish_event(owned, epoch, QuoteEvent(identity=identity, bid="99", ask="99",
            source_time=stamp, received_at=stamp, tradeable=True, connection_epoch=epoch,
            sequence=seq), identities)

    for row in entries.values():
        while aggregate_tick(row["revision_id"], "M1"):
            pass

    with transaction() as db:
        for symbol, row in entries.items():
            for index in range(5):
                cfg = AlertConfig.model_validate({"name": f"FIXTURE {symbol} {index}",
                    "instrument": row["composite_id"], "composite_revision_id": row["revision_id"],
                    "series_kind": "composite", "source": "composite", "mode": "intrabar",
                    "timeframe": "M1", "max_triggers": 3,
                    "condition": {"relation": "cross_up", "right": {"kind": "constant",
                        "value": str(100 + index / 10)}}})
                create(db, f"perf:{symbol}:{index}", cfg)

    counts, signal_commits, samples, collector, schedule_delay = {}, {}, {}, [], []
    stop = threading.Event()
    errors, load, backlog = [], [], []

    def evaluated(row):
        ident, count = row["alert_id"], row["count"] or 0
        for ordinal in range(counts.get(ident, 0) + 1, count + 1):
            signal_commits[ident, ordinal] = row["committed"]
        counts[ident] = count

    def monitor():
        def health(error=None, **_):
            if error:
                errors.append(error)
        run(stop, on_alert=evaluated, report_health=health)

    consumer = threading.Thread(target=monitor, daemon=True)
    consumer.start()
    time.sleep(2)
    load.append(os.getloadavg())
    start = time.monotonic()
    cpu = time.process_time()
    accepted = 0
    offered = seconds * 40
    keys = list(identities)
    peak_bursts = (seconds // 10 * 4, seconds // 2 * 4)
    try:
        for offset in range(offered):
            target = start + offset / 40
            time.sleep(max(0, target - time.monotonic()))
            mark = time.monotonic()
            schedule_delay.append(1000 * (mark - target))
            index = offset % 10
            round_index = offset // 10
            key = keys[index]
            # Two single observations above the level per symbol. All rules
            # stay active for the entire run (limit three).
            price = "101" if round_index in peak_bursts else "99"
            stamp = now_ms()
            seq += 1
            outcome = live_pricing.publish_event(owned, epoch, QuoteEvent(identity=identities[key], bid=price, ask=price,
                source_time=stamp, received_at=stamp, tradeable=True, connection_epoch=epoch, sequence=seq), identities)
            committed = time.monotonic()
            collector.append(1000 * (committed - mark))
            if outcome == "accepted":
                accepted += 1
                if price == "101":
                    samples[key, stamp] = committed
            if offset % 2400 == 2399:
                load.append(os.getloadavg())
                backlog.append({"offered": offset + 1, "offered_schedule_lag_ms": round(schedule_delay[-1], 2)})
        elapsed = time.monotonic() - start
        time.sleep(3)
    finally:
        stop.set()
        consumer.join(10)
    if consumer.is_alive():
        raise RuntimeError("Monitor did not stop after the performance run")
    with transaction() as db:
        rows = list(db.scalars(select(SignalRow)))
        ds_to_symbol = {identity.key: name for name, identity in identities.items()}
        latencies = []
        for signal in rows:
            identity = signal.evidence["market_identity"]
            key = ds_to_symbol[identity["target_dataset_id"]]
            sample = samples.get((key, signal.occurred_at))
            written = signal_commits.get((signal.chart_alert_id, signal.evidence["ordinal"]))
            if sample is not None and written is not None:
                latencies.append(1000 * (written - sample))
        rel_size = db.scalar(text("SELECT sum(pg_total_relation_size(c.oid)) FROM pg_class c "
            "JOIN pg_namespace n ON c.relnamespace=n.oid WHERE n.nspname=current_schema() AND c.relkind='r'"))
        logs_exist = db.scalar(text("SELECT to_regclass('price_alert_inputs') IS NOT NULL"))
        log_size = db.scalar(text("SELECT pg_total_relation_size('price_alert_inputs')")) if logs_exist else None
        log_rows = db.scalar(text("SELECT count(*) FROM price_alert_inputs")) if logs_exist else None
        active = db.scalar(select(func.count()).select_from(ChartAlert).where(ChartAlert.status == "active"))
        remaining = db.scalar(text("""
            SELECT max(s.sequence - (a.runtime->>'cursor')::bigint)
            FROM chart_alerts a JOIN chart_alert_versions v ON a.id=v.alert_id AND a.version=v.version
            JOIN price_alert_streams s ON s.dataset_id=v.market_identity->>'target_dataset_id'
        """)) if logs_exist else None
    return {"seconds_requested": seconds, "elapsed_s": elapsed, "offered": offered, "accepted": accepted,
        "observations_per_second": accepted / elapsed, "symbols": len(entries), "active_rules": active,
        "load_average": load, "process_cpu_seconds": time.process_time() - cpu,
        "process_peak_rss_kib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
        "schema_bytes": int(rel_size or 0), "input_log_bytes": log_size, "input_log_rows": log_rows,
        "collector_commit_p95_ms": percent95(collector), "input_to_signal_commit_p95_ms": percent95(latencies),
        "latency_samples": len(latencies), "signals": len(rows), "expected_signals": 100,
        "remaining_inputs": remaining, "schedule_lag_p95_ms": percent95(schedule_delay),
        "load_samples": backlog, "monitor_errors": sorted(set(errors)), "monitor_error_count": len(errors)}


def compare_performance(config, seconds):
    import sys
    import tarfile
    import tempfile
    from uuid import uuid4

    from sqlalchemy import create_engine, text
    from sqlalchemy.engine import make_url

    source = Path(__file__).resolve()
    repo = source.parents[1]
    baseline = "ef57bed61f66715a4c5ec2797f9abd67cb23d2fb"
    url = make_url(os.environ["ALERTS_DATABASE_URL"])
    admin = create_engine(url)
    result = {}
    with tempfile.TemporaryDirectory(prefix="perf-", dir=config.parent) as temp:
        temp = Path(temp)
        with subprocess.Popen(["git", "archive", baseline, "backend"], cwd=repo, stdout=subprocess.PIPE) as git:
            with tarfile.open(fileobj=git.stdout, mode="r|") as archive:
                archive.extractall(temp, filter="data")
            if git.wait() != 0:
                raise RuntimeError("Unable to extract fixed baseline")
        for name, code in (("baseline", temp / "backend"), ("candidate", repo / "backend")):
            schema = "price_perf_" + uuid4().hex
            with admin.begin() as conn:
                conn.execute(text(f"CREATE SCHEMA {schema}"))
            try:
                scoped_url = url.update_query_dict({"options": "-csearch_path=" + schema})
                proc = subprocess.run([sys.executable, str(source), "_perf", "--output", str(temp / (name + ".json")),
                    "--seconds", str(seconds)], cwd=repo, env={**os.environ, "PYTHONPATH": str(code),
                    "ALERTS_DATABASE_URL": scoped_url.render_as_string(hide_password=False),
                    "ALERTS_DATABASE_POOL_SIZE": "5", "MW_PRICE_PERF_SCHEMA": schema}, check=True)
                assert proc.returncode == 0
                result[name] = json.loads((temp / (name + ".json")).read_text())
            finally:
                with admin.begin() as conn:
                    conn.execute(text(f"DROP SCHEMA {schema} CASCADE"))
    admin.dispose()
    old, new = result["baseline"], result["candidate"]
    limit = max(old["collector_commit_p95_ms"] * 1.2, old["collector_commit_p95_ms"] + 20)
    fixed_load = all(row["offered"] == row["accepted"] and abs(row["elapsed_s"] - seconds) < 1
                     for row in result.values())
    passed = (seconds == 600 and fixed_load and new["signals"] == new["expected_signals"]
        and new["active_rules"] == 50 and new["remaining_inputs"] == 0
        and new["input_to_signal_commit_p95_ms"] is not None and new["input_to_signal_commit_p95_ms"] <= 2000
        and new["collector_commit_p95_ms"] <= limit and not new["monitor_errors"])
    return {"project": TASK, "synthetic": True, "baseline_sha": baseline, "fixed_load": fixed_load,
            "collector_limit_ms": limit, "passed": passed, **result}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["seed", "control", "evidence", "market", "notification", "perf", "_perf"],
                        nargs="?", default="seed")
    parser.add_argument("--config", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--symbols", type=int, choices=[1, 10], default=1)
    parser.add_argument("--set", type=json.loads, default={})
    parser.add_argument("--alert")
    parser.add_argument("--seconds", type=int, choices=[10, 600], default=600)
    args = parser.parse_args()
    if args.operation in ("market", "notification"):
        return {"market": market, "notification": notification}[args.operation]()
    if args.operation == "_perf":
        from sqlalchemy.engine import make_url

        url = make_url(os.environ["ALERTS_DATABASE_URL"])
        schema = os.environ.get("MW_PRICE_PERF_SCHEMA", "")
        if (os.environ.get("ALERTS_RUNTIME_DEPLOYMENT") != TASK or url.host != "127.0.0.1"
                or url.database != "price_alerts" or not schema.startswith("price_perf_")
                or url.query != {"options": "-csearch_path=" + schema}):
            raise SystemExit("Performance worker requires its own scoped schema")
        write_json(args.output, perf_worker(args.output.parent, args.seconds))
        return
    if not args.config or not args.output:
        parser.error("--config and --output are required")
    root = setup_host(args.config)
    if args.operation == "seed":
        result = seed(root, args.symbols)
    elif args.operation == "perf":
        result = compare_performance(args.config, args.seconds)
    elif args.operation == "control":
        if not set(args.set) <= {"price", "close_price", "online", "prime_until", "notification_response"}:
            parser.error("unknown fixture control")
        write_json(root / "control.json", {**read_control(root), **args.set})
        result = {"project": TASK, "controls_updated": sorted(args.set)}
    else:
        result = evidence(args.alert)
    write_json(args.output, result)


if __name__ == "__main__":
    main()
