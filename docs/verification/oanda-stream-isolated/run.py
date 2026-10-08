"""Ubuntu-only fault injection and ten-minute observation of installed code.

The supplier is synthetic. Worker, HTTPX/httpcore, database locks, confirmations,
publication and authenticated API reads use the installed application package.
No production account, token, dataset, notification or upstream stream is used.
"""

import argparse
import hashlib
import json
import logging
import os
import signal
import subprocess
import sys
import threading
import time
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import httpx
from alerts import live_pricing, oanda_worker, storage
from alerts.chart_aggregation_worker import cycle, wait_seconds
from alerts.config import settings
from alerts.publication_schedule import request
from alerts.storage import (
    ChartHistoryPlan,
    ChartPublication,
    ChartPublicationState,
    MarketDataset,
    Outbox,
    Preference,
    PricingOwner,
)
from argon2 import PasswordHasher
from sqlalchemy import func, select, text

CATALOG = [
    {"name": "EUR_USD", "type": "CURRENCY", "displayPrecision": 5},
    {"name": "XAU_USD", "type": "METAL", "displayPrecision": 3},
]
ACCOUNT = "isolated-synthetic-account"
STOP = threading.Event()
WARNINGS = []
FAULTS = []
SERVER_LOCK = threading.Lock()
CONNECTIONS = 0


def timestamp():
    return datetime.now(UTC).isoformat()


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


class Warnings(logging.Handler):
    def emit(self, record):
        if record.levelno >= logging.WARNING and record.name.startswith("alerts"):
            WARNINGS.append({"at": timestamp(), "logger": record.name, "message": record.getMessage()})


class Supplier(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass

    def do_GET(self):
        global CONNECTIONS
        url = urlsplit(self.path)
        if url.path.endswith("/instruments"):
            self.reply({"instruments": CATALOG})
        elif url.path.endswith("/candles"):
            query = parse_qs(url.query)
            start, end = int(float(query["from"][0]) * 1000), int(float(query["to"][0]) * 1000)
            symbol = url.path.split("/")[-2]
            value = "2300.001" if symbol == "XAU_USD" else "1.10001"
            self.reply({"instrument": symbol, "granularity": "M1", "candles": [
                {"time": str(at // 1000), "complete": True,
                 "bid": {"o": value, "h": value, "l": value, "c": value}, "volume": 10}
                for at in range(start, end, 60000)]})
        elif url.path.endswith("/pricing/stream"):
            with SERVER_LOCK:
                CONNECTIONS += 1
                ordinal = CONNECTIONS
            if ordinal == 1:
                FAULTS.append({"at": timestamp(), "mode": "receive_headers", "connection": ordinal})
                STOP.wait(16)
                self.close_connection = True
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            try:
                self.records()
                if ordinal == 2:
                    FAULTS.append({"at": timestamp(), "mode": "receive_body", "connection": ordinal})
                    STOP.wait(16)
                    self.close_connection = True
                    return
                while not STOP.wait(1):
                    self.records()
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                self.close_connection = True
        else:
            self.send_error(404)

    def records(self):
        for meta in CATALOG:
            value = "2300.001" if meta["name"] == "XAU_USD" else "1.10001"
            ask = "2300.011" if meta["name"] == "XAU_USD" else "1.10011"
            self.chunk({"type": "PRICE", "instrument": meta["name"],
                        "time": str(time.time()), "tradeable": True,
                        "bids": [{"price": value}], "asks": [{"price": ask}]})
        self.chunk({"type": "HEARTBEAT", "time": str(time.time())})

    def chunk(self, record):
        data = (json.dumps(record) + "\n").encode()
        self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
        self.wfile.flush()

    def reply(self, body):
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class LocalClient(httpx.Client):
    """Redirect only the two adapter origins, retaining real transport/timeouts."""

    def send(self, request, **kwargs):
        if request.url.host not in ("api-fxpractice.oanda.com", "stream-fxpractice.oanda.com"):
            raise AssertionError("Unexpected supplier destination")
        request.url = request.url.copy_with(scheme="http", host="127.0.0.1", port=8700)
        return super().send(request, **kwargs)


def publisher():
    while not STOP.is_set():
        try:
            worked, published = cycle()
            STOP.wait(wait_seconds(worked, published))
        except Exception as error:
            logging.getLogger("alerts.isolated_publisher").warning(
                "publisher_failed type=%s", type(error).__name__)
            STOP.wait(1)


def collect(adapter):
    try:
        oanda_worker.run(adapter, STOP)
    except Exception as error:
        logging.getLogger("alerts.isolated_worker").warning("worker_failed type=%s", type(error).__name__)
        STOP.set()


def snapshot(client):
    response = client.get("/api/market-data/live")
    response.raise_for_status()
    fields = ("logical_symbol", "quality", "connection", "connection_epoch", "recovery_ready",
              "quote_ready", "candle_ready", "quote_age_ms", "heartbeat_at", "last_confirmed_m1")
    rows = [{key: row[key] for key in fields} for row in response.json()]
    with storage.transaction() as db:
        db.execute(text("SET TRANSACTION READ ONLY"))
        owners = [{"epoch": row.epoch, "failures": row.failures,
                   "error": row.error, "lease_remaining_ms": row.expires - storage.now_ms()}
                  for row in db.scalars(select(PricingOwner))]
        publications = [{"frame": row.timeframe, "end": row.end, "revision": row.revision}
                        for row in db.scalars(select(ChartPublication).where(ChartPublication.timeframe == "M1"))]
        publication_errors = db.scalar(select(func.count()).select_from(ChartPublicationState).where(
            ChartPublicationState.attempts > 0))
        outbox = db.scalar(select(func.count()).select_from(Outbox))
        waiting = db.scalar(text("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() "
                                 "AND state='idle in transaction'"))
    return {"at": timestamp(), "rows": rows, "owners": owners, "publications": publications,
            "publication_errors": publication_errors, "outbox": outbox, "idle_transactions": waiting}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--seconds", type=int, default=600)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not 60 <= args.seconds <= 1800:
        parser.error("seconds must be 60..1800")
    args.output.mkdir(mode=0o700, parents=True, exist_ok=True)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger().addHandler(Warnings())
    signal.signal(signal.SIGTERM, lambda *_: STOP.set())
    signal.signal(signal.SIGINT, lambda *_: STOP.set())
    assert not settings.delivery_enabled and not settings.oanda_token and not settings.oanda_account_id
    assert settings.database_url.startswith("postgresql")
    storage.Base.metadata.create_all(storage.engine)
    settings.oanda_resident_symbols = "EUR_USD,XAU_USD"
    settings.oanda_recovery_minutes = 120
    live_pricing.ensure_catalog(CATALOG, ACCOUNT)
    identities = live_pricing.desired_datasets(ACCOUNT)
    cutoff = (storage.now_ms() - 5000) // 60000 * 60000
    password = os.environ["ISOLATED_API_PASSWORD"]
    with storage.transaction() as db:
        assert db.scalar(select(PricingOwner)) is None, "Use a fresh isolated DB"
        db.merge(Preference(key="auth.admin", value={"hash": PasswordHasher().hash(password)}))
        for identity in identities.values():
            instrument = db.get(MarketDataset, identity.key).instrument_id
            db.add(ChartHistoryPlan(instrument_id=instrument, status="cancelled", realtime_enabled=True,
                                   target_start=cutoff - 120 * 60000, target_end=cutoff, cursor=cutoff))
            db.flush()
            request(db, instrument, frames=("M1",), approved=True)
    module_hashes = {}
    for module in (live_pricing, oanda_worker, storage):
        path = Path(module.__file__)
        assert "site-packages/alerts" in str(path), "Exercise the installed image"
        module_hashes[module.__name__] = hashlib.sha256(path.read_bytes()).hexdigest()
    server = ThreadingHTTPServer(("0.0.0.0", 8700), Supplier)
    threads = [threading.Thread(target=server.serve_forever, daemon=True),
               threading.Thread(target=publisher, daemon=True)]
    api = subprocess.Popen([sys.executable, "-m", "uvicorn", "alerts.api:app", "--lifespan", "off",
                            "--host", "0.0.0.0", "--port", "8000", "--log-level", "warning"])
    rest = LocalClient(trust_env=False, timeout=httpx.Timeout(15, connect=5))
    stream = LocalClient(trust_env=False, timeout=httpx.Timeout(15, connect=5),
                         limits=httpx.Limits(max_connections=1))
    adapter = oanda_worker.OandaPractice(token="synthetic-test-only", account_id=ACCOUNT,
                                       rest_client=rest, stream_client=stream)
    threads.append(threading.Thread(target=collect, args=(adapter,), daemon=True))
    samples = []
    try:
        for thread in threads:
            thread.start()
        with httpx.Client(base_url="http://127.0.0.1:8000", trust_env=False, timeout=10) as client:
            deadline = time.monotonic() + 180
            while True:
                try:
                    response = client.post("/api/login", json={"password": password})
                    response.raise_for_status()
                    csrf = response.json()["csrf"]
                    break
                except httpx.ConnectError:
                    if time.monotonic() >= deadline:
                        raise
                    STOP.wait(0.1)
            # Injection/recovery is separate from the steady ten-minute window.
            with (args.output / "fault-recovery.jsonl").open("w") as output:
                while time.monotonic() < deadline and not STOP.is_set():
                    sample = snapshot(client)
                    output.write(json.dumps(sample) + "\n")
                    output.flush()
                    if (CONNECTIONS >= 3 and len(sample["rows"]) == 2
                            and all(row["quality"] == "healthy" for row in sample["rows"])):
                        break
                    STOP.wait(1)
                else:
                    raise AssertionError("Worker did not recover within 180 seconds")
            faults = [row["message"] for row in WARNINGS if "pricing_transport_failed" in row["message"]]
            assert any("phase=receive_headers" in row and "records=0" in row for row in faults)
            assert any("phase=receive_body" in row and "records=3" in row for row in faults)
            warning_start = len(WARNINGS)
            started = time.monotonic()
            print(json.dumps({"event": "observation_started", "at": timestamp(),
                              "seconds": args.seconds, "epoch": sample["owners"][0]["epoch"]}), flush=True)
            with (args.output / "observation.jsonl").open("w") as output:
                while not STOP.is_set():
                    sample = snapshot(client)
                    samples.append(sample)
                    output.write(json.dumps(sample) + "\n")
                    output.flush()
                    print(json.dumps({"at": sample["at"], "epoch": sample["owners"][0]["epoch"],
                                      "quality": [row["quality"] for row in sample["rows"]],
                                      "confirmed": [row["last_confirmed_m1"] for row in sample["rows"]],
                                      "publication_errors": sample["publication_errors"]}), flush=True)
                    remaining = args.seconds - (time.monotonic() - started)
                    if remaining <= 0:
                        break
                    STOP.wait(min(5, remaining))
            elapsed = time.monotonic() - started
            checks = {
                "full_window": elapsed >= args.seconds,
                "constant_epoch": len({s["owners"][0]["epoch"] for s in samples}) == 1,
                "fresh_healthy_rows": all(len(s["rows"]) == 2 and all(
                    r["quality"] == "healthy" and r["quote_ready"] and r["candle_ready"]
                    for r in s["rows"]) for s in samples),
                "leases_valid": all(s["owners"][0]["lease_remaining_ms"] > 0 for s in samples),
                "confirmed_minutes_advance": all(samples[-1]["rows"][i]["last_confirmed_m1"]
                    - samples[0]["rows"][i]["last_confirmed_m1"] >= (args.seconds // 60 - 1) * 60000
                    for i in range(2)),
                "publication_advances": bool(samples[0]["publications"]) and
                    max(p["end"] for p in samples[-1]["publications"]) >
                    max(p["end"] for p in samples[0]["publications"]),
                "no_publication_errors": all(s["publication_errors"] == 0 for s in samples),
                "no_notifications": all(s["outbox"] == 0 for s in samples),
                "no_idle_transactions": all(s["idle_transactions"] == 0 for s in samples),
                "no_new_warnings": len(WARNINGS) == warning_start,
            }
            report = {"environment": "Ubuntu Docker / synthetic supplier / installed application",
                      "start": samples[0]["at"], "end": samples[-1]["at"],
                      "elapsed_seconds": round(elapsed, 3), "samples": len(samples), "checks": checks,
                      "faults": FAULTS, "warnings": WARNINGS, "module_hashes": module_hashes,
                      "supplier_connections": CONNECTIONS, "first": samples[0], "last": samples[-1]}
            save(args.output / "report.json", report)
            print(json.dumps({"event": "observation_finished", "checks": checks}), flush=True)
            response = client.post("/api/logout", json={}, headers={"x-csrf-token": csrf})
            response.raise_for_status()
            assert all(checks.values()), "Observation failed; inspect report.json"
    finally:
        STOP.set()
        server.shutdown()
        for thread in threads:
            thread.join(timeout=25)
        rest.close()
        stream.close()
        server.server_close()
        api.terminate()
        api.wait(timeout=10)
        save(args.output / "warnings.json", WARNINGS)


if __name__ == "__main__":
    main()
