"""Local fault seams around real OANDA transport in the isolated Ubuntu project.

Never send invalid credentials or provoke upstream rate limits. A one-off
collector replaces this project's worker temporarily; finally restores it.
"""

import argparse
import json
import logging
import shlex
import signal
import subprocess
import threading
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
PROJECT = "market-watch-data-integration"
NAME = PROJECT + "-response-fault"
COMPOSE = ["docker", "compose", "--env-file", "artifacts/data-integration/compose.env",
           "-p", PROJECT, "-f", "docs/verification/data-integration/compose.yaml"]


def emit(kind, **details):
    print(json.dumps({"event": kind, "at": int(time.time() * 1000), **details}), flush=True)


def inside(fault):
    from alerts.config import settings
    from alerts.live_pricing import snapshots
    from alerts.market_contracts import QuoteEvent
    from alerts.oanda_stream import OandaPractice
    from alerts.oanda_worker import run

    logging.basicConfig(level=logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    adapter = OandaPractice(token=settings.oanda_token, account_id=settings.oanda_account_id,
                           proxy=settings.oanda_proxy or settings.market_proxy)
    original_get = adapter.rest.get
    original_stream = adapter.stream
    ready_at = None
    injected = False
    dropped = 0
    restored = False
    fault_started = None
    watch_id = None

    if fault == "single_symbol":
        from alerts.service import create_watch
        from alerts.storage import MarketDataset, Watch, transaction
        from sqlalchemy import select

        with transaction() as db:
            dataset = next(row for row in db.scalars(select(MarketDataset))
                           if row.logical_symbol == "EURUSD" and row.identity["source"] == "oanda")
            watch = create_watch(db, dataset.instrument_id, "single-symbol fault acceptance",
                {"kind": "price", "timeframe": "tick", "direction": "both", "level": "999999"},
                use_history=False)
            watch_id = watch.id

    def armed():
        nonlocal ready_at
        if ready_at is None:
            rows = snapshots()
            if len(rows) >= 2 and all(row["quality"] == "healthy" for row in rows):
                ready_at = time.monotonic()
                emit("armed")
        return ready_at is not None and time.monotonic() - ready_at >= 10

    def get(url, **kwargs):
        nonlocal injected
        if url.endswith("/candles"):
            if fault != "single_symbol" and not injected and armed():
                injected = True
                status = 401 if fault == "unauthorized" else 429
                emit("injected", status=status, retry_after_seconds=20 if status == 429 else None)
                # Synthetic request URL cannot expose the real account or token.
                return httpx.Response(status, headers={"Retry-After": "20"} if status == 429 else {},
                                      request=httpx.Request("GET", "https://local-fault.invalid/candles"))
            emit("rest_call", injected_already=injected)
        return original_get(url, **kwargs)

    def stream(identities, *, epoch, stopped):
        nonlocal injected, dropped, restored, fault_started
        emit("stream_started", epoch=epoch)
        for event in original_stream(identities, epoch=epoch, stopped=stopped):
            if fault == "single_symbol" and armed():
                if not injected:
                    injected = True
                    fault_started = time.monotonic()
                    emit("injected", symbol="EURUSD", duration_seconds=40)
                if time.monotonic() - fault_started < 40:
                    if isinstance(event, QuoteEvent) and event.identity.provider_symbol == "EUR_USD":
                        dropped += 1
                        continue
                elif not restored:
                    restored = True
                    emit("filter_removed", dropped_quotes=dropped)
                    # Make the first returning real quote cross a deliberately
                    # seeded synthetic pre-gap state. The collector must reset
                    # that state before evaluating, without inventing a signal.
                    with transaction() as db:
                        watch = db.get(Watch, watch_id)
                        if watch.status != "active":
                            raise RuntimeError("Fault watch unexpectedly triggered during suppression")
                        # Actual EURUSD is below this threshold; a retained
                        # high pre-gap value would fabricate a sell crossing.
                        watch.state = {"quote": "1000000", "quote_at": int(time.time() * 1000) - 40000}
            yield event
            if fault == "single_symbol" and restored is True and isinstance(event, QuoteEvent) and (
                    event.identity.provider_symbol == "EUR_USD"):
                with transaction() as db:
                    watch = db.get(Watch, watch_id)
                    from decimal import Decimal

                    if watch.status != "active" or Decimal(watch.state.get("quote", "0")) != Decimal(event.bid):
                        raise RuntimeError("A returning real quote fabricated a gap crossing")
                emit("gap_crossing_suppressed", watch_state_reseeded=True)
                # Check the first return only; subsequent ticks remain normal.
                restored = "checked"

    adapter.rest.get = get
    adapter.stream = stream
    timer = threading.Timer(300, stop.set)
    timer.start()
    try:
        run(adapter, stop)
    finally:
        timer.cancel()
        adapter.close()
        if watch_id:
            with transaction() as db:
                watch = db.get(Watch, watch_id)
                if watch.status == "active":
                    watch.status = "cancelled"


def command(arguments, *, capture=False):
    return subprocess.run(["sg", "docker", "-c", shlex.join(arguments)], cwd=ROOT,
                          check=True, stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                          stderr=subprocess.DEVNULL, timeout=50, text=True)


def main(fault):
    events = []
    result = {"fault": fault, "injection": "local response/filter seam; upstream otherwise real",
              "host": "Ubuntu local Docker", "project": PROJECT, "started_at": int(time.time() * 1000)}
    process = None
    with httpx.Client(base_url="http://127.0.0.1:16589", timeout=10, trust_env=False) as client:
        client.post("/api/login", json=json.loads((ROOT / "artifacts/data-integration/login.json")
                    .read_text())).raise_for_status()
        session = client.get("/api/session")
        session.raise_for_status()
        client.headers["X-CSRF-Token"] = session.json()["csrf"]

        def rows():
            response = client.get("/api/market-data/live")
            response.raise_for_status()
            return {row["logical_symbol"]: row for row in response.json()}

        def healthy():
            state = rows()
            return state and all(row["quality"] == "healthy" for row in state.values())

        ready_deadline = time.monotonic() + 90
        while not healthy():
            if time.monotonic() >= ready_deadline:
                raise RuntimeError("Regular collector must be healthy before injection")
            time.sleep(1)
        try:
            command(COMPOSE + ["stop", "oanda-worker"])
            arguments = COMPOSE + ["run", "--rm", "--no-deps", "-T", "--name", NAME,
                                   "oanda-worker", "python", "-", "--inside", fault]
            process = subprocess.Popen(["sg", "docker", "-c", shlex.join(arguments)], cwd=ROOT,
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                       text=True)
            process.stdin.write(Path(__file__).read_text())
            process.stdin.close()

            def consume():
                for line in process.stdout:
                    try:
                        event = json.loads(line)
                    except ValueError:
                        continue
                    events.append(event)
                    print(json.dumps(event), flush=True)

            reader = threading.Thread(target=consume, daemon=True)
            reader.start()
            deadline = time.monotonic() + 270
            hold_started = None
            hold_epoch = None
            reset = False
            stale = False
            while time.monotonic() < deadline:
                state = rows()
                injection = next((event for event in events if event["event"] == "injected"), None)
                if injection:
                    if fault == "unauthorized":
                        if all(row["error"] == "unauthorized" and row["connection"] == "disconnected"
                               for row in state.values()):
                            epochs = {symbol: row["connection_epoch"] for symbol, row in state.items()}
                            if hold_started is None:
                                hold_started, hold_epoch = time.monotonic(), epochs
                            if epochs != hold_epoch:
                                raise RuntimeError("Unauthorized hold reconnected without explicit retry")
                            if time.monotonic() - hold_started >= 20 and not reset:
                                response = client.post("/api/market-data/live/retry")
                                response.raise_for_status()
                                result["retry"] = response.json()
                                if result["retry"]["reset_configuration_faults"] != 1:
                                    raise RuntimeError("Authenticated retry did not clear exactly one account fault")
                                result["configuration_hold_seconds"] = round(time.monotonic() - hold_started, 3)
                                reset = True
                        if reset and healthy():
                            result["passed"] = True
                            break
                    elif fault == "rate_limited":
                        calls = [event for event in events if event["event"] == "rest_call"
                                 and event["at"] > injection["at"]]
                        if calls:
                            delay = min(event["at"] for event in calls) - injection["at"]
                            result["first_rest_after_injection_ms"] = delay
                            if delay < 20000:
                                raise RuntimeError("REST ignored the shared Retry-After cooldown")
                            if healthy() and all(row["last_confirmed_m1"] > injection["at"] // 60000 * 60000
                                                 for row in state.values()):
                                if any(event["event"] == "stream_started" and event["at"] > injection["at"]
                                       for event in events):
                                    raise RuntimeError("REST rate limit unnecessarily restarted the stream")
                                result["passed"] = True
                                break
                    else:
                        eur, xau = state["EURUSD"], state["XAUUSD"]
                        if eur["quality"] == "stale" and not eur["quote_ready"]:
                            stale = True
                            if xau["quality"] != "healthy" or not xau["quote_ready"]:
                                raise RuntimeError("Single-symbol suppression affected the other symbol")
                            result["stale_evidence"] = {"eur_quality": eur["quality"],
                                "eur_quote_ready": eur["quote_ready"], "eur_candle_ready": eur["candle_ready"],
                                "xau_quality": xau["quality"], "epoch": eur["connection_epoch"]}
                        if stale and any(event["event"] == "gap_crossing_suppressed" for event in events) and healthy():
                            removed = next(event for event in events if event["event"] == "filter_removed")
                            if removed["dropped_quotes"] < 1:
                                raise RuntimeError("No real EURUSD quote was suppressed")
                            if any(event["event"] == "stream_started" and event["at"] > injection["at"]
                                   for event in events):
                                raise RuntimeError("Single-symbol gap restarted the shared stream")
                            result["passed"] = True
                            break
                if process.poll() is not None:
                    raise RuntimeError("Fault collector exited before acceptance finished")
                time.sleep(1)
            else:
                raise RuntimeError("Fault acceptance exceeded its bounded observation window")
        except Exception as error:
            result["passed"] = False
            result["error_type"] = type(error).__name__
            result["error"] = str(error)
            raise
        finally:
            if process is not None:
                try:
                    command(["docker", "stop", "--time", "25", NAME])
                except subprocess.CalledProcessError:
                    pass
                process.wait(timeout=40)
            command(COMPOSE + ["start", "oanda-worker"])
            result["events"] = list(events)
            result["finished_at"] = int(time.time() * 1000)
            destination = ROOT / "docs/verification/data-integration" / f"fault-{fault}.json"
            destination.write_text(json.dumps(result, indent=2))
    print(json.dumps({key: value for key, value in result.items() if key != "events"}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--inside", action="store_true")
    parser.add_argument("fault", choices=("unauthorized", "rate_limited", "single_symbol"))
    args = parser.parse_args()
    inside(args.fault) if args.inside else main(args.fault)
