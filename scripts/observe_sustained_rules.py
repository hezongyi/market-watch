"""Observe only the two owned Ubuntu acceptance rules, without changing them."""

import argparse
import json
import os
import re
import signal
import subprocess
import threading
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
PREFIX = "Ubuntu sustained M1 acceptance "


def sanitize(watches, live, owned):
    by_id = {watch["id"]: watch for watch in watches}
    by_instrument = {row["instrument_id"]: row for row in live}
    result = []
    for ident, instrument in owned.items():
        watch, source = by_id.get(ident), by_instrument.get(instrument)
        if watch is not None and (watch["instrument_id"] != instrument
                                  or not watch["name"].startswith(PREFIX)):
            raise ValueError("Owned rule identity changed")
        quote = source.get("quote") or {} if source else {}
        result.append({"watch_id": ident, "instrument_id": instrument,
            "watch_present": watch is not None, "source_present": source is not None,
            "status": watch["status"] if watch else None,
            "armed_at": watch["armed_at"] if watch else None,
            "last_event": watch["state"].get("last_event") if watch else None,
            "paused_reason": watch["paused_reason"] if watch else None,
            "quality": source["quality"] if source else None,
            "connection_epoch": source["connection_epoch"] if source else None,
            "last_confirmed_m1": source["last_confirmed_m1"] if source else None,
            "calendar_verified": source["calendar_verified"] if source else None,
            "quote_source_time": quote.get("source_time"),
            "quote_received_at": quote.get("received_at"),
            "quote_tradeable": quote.get("tradeable")})
    return result


def clock_sample():
    try:
        output = subprocess.run(["timedatectl", "timesync-status"], capture_output=True,
                                text=True, timeout=5, check=True).stdout
        # Keep measurement fields, never host names or process diagnostics.
        fields = {key: value.strip() for key, value in re.findall(
            r"^\s*(Leap|Root distance|Offset|Delay|Jitter|Packet count):\s*(.*)$",
            output, re.MULTILINE)}
        return {"available": bool(fields), "fields": fields,
                "meaning": "receiver NTP sample only; supplier offset remains unverified"}
    except (OSError, subprocess.SubprocessError):
        return {"available": False, "meaning": "receiver NTP sample unavailable"}


def observe(output, owned, credential, minutes, interval, renewal_minutes, phase):
    stopped = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stopped.set())
    signal.signal(signal.SIGTERM, lambda *_: stopped.set())
    started = int(time.time() * 1000)
    planned_end = started + int(minutes * 60_000)
    deadline = time.monotonic() + minutes * 60
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(descriptor, "w", buffering=1) as evidence, httpx.Client(
            base_url="http://127.0.0.1:16589", timeout=10, trust_env=False) as client:
        def append(event, **details):
            evidence.write(json.dumps({"event": event, "at": int(time.time() * 1000),
                                       "phase": phase, **details}) + "\n")

        append("started", started_at=started, planned_end=planned_end,
               planned_minutes=minutes, poll_interval_seconds=interval,
               authentication_renewal_minutes=renewal_minutes, owned=owned,
               host="Ubuntu host observing local isolated Docker API",
               url="http://127.0.0.1:16589", source_clock_offset_verified=False)
        authenticated_at = None
        next_clock = 0
        previous_monotonic = previous_utc = None
        while not stopped.is_set() and time.monotonic() < deadline:
            poll_monotonic, poll_utc = time.monotonic(), int(time.time() * 1000)
            if previous_monotonic is not None:
                elapsed = (poll_monotonic - previous_monotonic) * 1000
                append("poll_clock", interval_ms=round(elapsed),
                       wall_minus_monotonic_ms=round(poll_utc - previous_utc - elapsed))
            previous_monotonic, previous_utc = poll_monotonic, poll_utc
            try:
                if (authenticated_at is None
                        or poll_monotonic - authenticated_at >= renewal_minutes * 60):
                    login = client.post("/api/login", json=credential)
                    login.raise_for_status()
                    authenticated_at = time.monotonic()
                    append("authenticated")

                response = client.get("/api/watches")
                response.raise_for_status()
                watches = response.json()
                response = client.get("/api/market-data/live")
                response.raise_for_status()
                rows = sanitize(watches, response.json(), owned)
                append("sample", request_started_at=poll_utc,
                       request_duration_ms=round((time.monotonic() - poll_monotonic) * 1000),
                       watches=rows)
            except (httpx.HTTPError, ValueError, KeyError, TypeError) as error:
                code = error.response.status_code if isinstance(error, httpx.HTTPStatusError) else None
                append("poll_failed", error_type=type(error).__name__, status_code=code)
                if code in (401, 403):
                    authenticated_at = None
            if time.monotonic() >= next_clock:
                append("receiver_clock", **clock_sample())
                next_clock = time.monotonic() + 3600
            # Finite, interruptible wait. Failed polls stay in the same window.
            stopped.wait(min(max(0.1, interval - (time.monotonic() - poll_monotonic)),
                             max(0, deadline - time.monotonic())))
        append("finished", interrupted=stopped.is_set(), planned_end=planned_end)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--minutes", type=float, default=2880)
    parser.add_argument("--interval", type=float, default=15)
    parser.add_argument("--renewal-minutes", type=float, default=720)
    parser.add_argument("--phase", choices=("sustained", "tool-validation"), default="sustained")
    args = parser.parse_args()
    if not (1 <= args.minutes <= 4320 and 1 <= args.interval <= 30
            and 1 <= args.renewal_minutes <= 720):
        parser.error("Require minutes 1–4320, interval 1–30s, renewal 1–720 minutes")
    initial = json.loads((ROOT / "docs/verification/data-integration/sustained-m1-watches-start.json").read_text())
    owned = {watch["id"]: watch["instrument_id"] for watch in initial["watches"]}
    if len(owned) != 2 or any(not watch["name"].startswith(PREFIX) for watch in initial["watches"]):
        parser.error("Require exactly the two owned acceptance rules")
    credential = json.loads((ROOT / "artifacts/data-integration/login.json").read_text())
    observe(ROOT / f"artifacts/data-integration/rules-{args.phase}.jsonl", owned, credential,
            args.minutes, args.interval, args.renewal_minutes, args.phase)
