"""Opt-in verification counters; original synchronous pipeline stays in place.

Only the dedicated Ubuntu verification process installs these wrappers. No
payload, account identity, prices, URL or exception text is retained. A decoded
PRICE increments received before yielding; accepted increments only after the
original publish_event transaction has returned successfully.
"""

import copy
import json
import threading
import time
from collections import deque
from contextlib import contextmanager

from alerts import oanda_stream, oanda_worker
from alerts.market_contracts import QuoteEvent
from transport_observation import NetworkObservation, observe_network, scoped

_CURRENT = threading.local()
OUTCOMES = ("accepted", "rejected_old_source", "rejected_sequence", "rejected_duplicate")


def duration_bucket(milliseconds):
    return next((str(bound) for bound in (1, 10, 100, 1000, 5000, 15000)
                 if milliseconds <= bound), "over_15000")


class PipelineObservation:
    def __init__(self, epoch, symbols, *, clock=time.monotonic, wall=time.time):
        self.epoch, self.clock, self.wall = epoch, clock, wall
        self.symbols = dict(symbols)
        self.network = NetworkObservation(clock=clock)
        self.lock = threading.Lock()
        self.data = {"epoch": epoch, "started_at": clock(), "finished_at": None,
                     "end": None, "chunks": 0, "chunk_bytes": 0, "last_chunk_at": None,
                     "records": 0, "heartbeats": 0, "last_record_at": None,
                     "buffer_bytes": 0, "buffer_peak_bytes": 0, "decode_errors": 0,
                     "decode_error_kinds": {k: 0 for k in
                         ("JSONDecodeError", "UnicodeDecodeError", "ValueError", "Other")},
                     "decode_max_ms": 0, "yielded": 0, "last_yield_at": None,
                     "consumer_max_ms": 0, "consumer_total_ms": 0,
                     "next_active_since": None, "next_max_ms": 0,
                     "publish_active_since": None, "publish_started": 0,
                     "publish_completed": 0, "publish_errors": 0,
                     "unmatched_publish": 0,
                     "publish_max_ms": 0, "publish_total_ms": 0,
                     "publish_ms_histogram": {}, "symbols": {}}
        for symbol in symbols.values():
            self.data["symbols"][symbol] = {"received": 0, "delivered": 0, "accepted": 0,
                "rejected_old_source": 0, "rejected_sequence": 0, "rejected_duplicate": 0,
                "errors": 0, "fencing_or_timeout_errors": 0, "pending": 0,
                "cancelled_before_publish": 0, "max_source_time": None,
                "last_received_at": None, "last_accepted_at": None,
                "source_age_ms_histogram": {}}

    def decoded(self, chunk, decoder, raw_records, started, error=None):
        now = self.clock()
        pending_utf8 = decoder.decoder.getstate()[0]
        buffered = len(decoder.buffer.encode()) + len(pending_utf8)
        with self.lock:
            self.data["chunks"] += 1
            self.data["chunk_bytes"] += len(chunk)
            self.data["last_chunk_at"] = started
            self.data["decode_max_ms"] = max(self.data["decode_max_ms"], (now-started)*1000)
            self.data["buffer_bytes"] = buffered
            self.data["buffer_peak_bytes"] = max(self.data["buffer_peak_bytes"], buffered)
            if error is not None:
                self.data["decode_errors"] += 1
                kind = next((kind for kind in ("JSONDecodeError", "UnicodeDecodeError", "ValueError")
                             if type(error).__name__ == kind), "Other")
                self.data["decode_error_kinds"][kind] += 1
                return
            self.data["records"] += len(raw_records)
            if raw_records:
                self.data["last_record_at"] = now
            for raw in raw_records:
                if raw.get("type") == "HEARTBEAT":
                    self.data["heartbeats"] += 1
                elif raw.get("type") == "PRICE" and raw.get("instrument") in self.symbols:
                    row = self.data["symbols"][self.symbols[raw["instrument"]]]
                    row["received"] += 1
                    row["pending"] += 1
                    row["last_received_at"] = now
                    try:
                        source = oanda_stream.timestamp(raw["time"])
                    except (ValueError, TypeError, KeyError, OverflowError):
                        continue
                    row["max_source_time"] = max(row["max_source_time"] or 0, source)
                    age = self.wall()*1000-source
                    bucket = "future" if age < 0 else duration_bucket(age)
                    histogram = row["source_age_ms_histogram"]
                    histogram[bucket] = histogram.get(bucket, 0)+1

    def yielded(self, event):
        with self.lock:
            self.data["yielded"] += 1
            self.data["last_yield_at"] = self.clock()
            if isinstance(event, QuoteEvent) and event.identity.provider_symbol in self.symbols:
                self.data["symbols"][self.symbols[event.identity.provider_symbol]]["delivered"] += 1

    def publish(self, function, ownership, epoch, event, identities):
        started = self.clock()
        outcome, failed = None, None
        with self.lock:
            self.data["publish_active_since"] = started
            self.data["publish_started"] += 1
        try:
            outcome = function(ownership, epoch, event, identities)
            return outcome
        except BaseException as error:
            failed = "fencing_or_timeout_errors" if isinstance(error, TimeoutError) else "errors"
            raise
        finally:
            now = self.clock()
            milliseconds = (now-started)*1000
            with self.lock:
                self.data["publish_active_since"] = None
                self.data["publish_total_ms"] += milliseconds
                self.data["publish_max_ms"] = max(self.data["publish_max_ms"], milliseconds)
                histogram = self.data["publish_ms_histogram"]
                bucket = duration_bucket(milliseconds)
                histogram[bucket] = histogram.get(bucket, 0)+1
                self.data["publish_errors" if failed else "publish_completed"] += 1
                if isinstance(event, QuoteEvent) and event.identity.provider_symbol in self.symbols:
                    row = self.data["symbols"][self.symbols[event.identity.provider_symbol]]
                    if row["pending"] < 1:
                        self.data["unmatched_publish"] += 1
                    elif failed:
                        row["pending"] -= 1
                        row["errors"] += 1
                        if failed != "errors":
                            row[failed] += 1
                    elif outcome in OUTCOMES:
                        row["pending"] -= 1
                        row[outcome] += 1
                        if outcome == "accepted":
                            row["last_accepted_at"] = now
                    else:
                        row["pending"] -= 1
                        # A missing observation contract is visible, never counted accepted.
                        row["errors"] += 1

    def finish(self, reason):
        with self.lock:
            self.data["finished_at"], self.data["end"] = self.clock(), reason
            for row in self.data["symbols"].values():
                row["cancelled_before_publish"] += row["pending"]
                row["errors"] += row["pending"]
                row["pending"] = 0

    def snapshot(self):
        with self.lock:
            result = copy.deepcopy(self.data)
        now = self.clock()
        for key in ("publish", "next"):
            active = result[key+"_active_since"]
            result[key+"_active_ms"] = (now-active)*1000 if active is not None else 0
        result["sampled_at"] = now
        result["network"] = self.network.snapshot()
        result["accounting_valid"] = all(r["received"] == sum(r[k] for k in OUTCOMES)
            + r["errors"] + r["pending"] for r in result["symbols"].values())
        return result


class ObservationRegistry:
    """Keep bounded recent epochs; the independent recorder persists snapshots."""

    def __init__(self, symbols, *, limit=16):
        self.symbols, self.lock = dict(symbols), threading.Lock()
        self.epochs, self.limit, self.evicted = deque(), limit, 0

    def start(self, epoch):
        observation = PipelineObservation(epoch, self.symbols)
        with self.lock:
            if len(self.epochs) == self.limit:
                self.epochs.popleft()
                self.evicted += 1
            self.epochs.append(observation)
        return observation

    def snapshot(self):
        with self.lock:
            observations, evicted = list(self.epochs), self.evicted
        return {"epochs": [x.snapshot() for x in observations], "evicted_epochs": evicted}


class SnapshotRecorder:
    """Independent bounded observer; file I/O stays outside the business thread."""

    def __init__(self, snapshot, output, *, interval=1):
        self.snapshot, self.output, self.interval = snapshot, output, interval
        self.stop = threading.Event()
        self.delay_max_ms = 0
        self.samples = 0
        self.failure_kind = None
        self.thread = threading.Thread(target=self.run, name="oanda-observation", daemon=True)

    def run(self):
        from datetime import UTC, datetime

        scheduled = time.monotonic()
        try:
            with self.output.open("x") as output:
                while True:
                    now = time.monotonic()
                    delay = max(0, (now-scheduled)*1000)
                    self.delay_max_ms = max(self.delay_max_ms, delay)
                    data = self.snapshot()
                    self.samples += 1
                    output.write(json.dumps({"at": datetime.now(UTC).isoformat(),
                        "sample_monotonic": now, "observer_delay_ms": delay,
                        "observer_delay_max_ms": self.delay_max_ms, **data})+"\n")
                    output.flush()
                    if self.stop.is_set():
                        break
                    scheduled = now+self.interval
                    self.stop.wait(max(0, scheduled-time.monotonic()))
        except BaseException as error:
            # Never copy exception text (paths, data or credentials) into evidence.
            self.failure_kind = "OSError" if isinstance(error, OSError) else "Other"

    def start(self):
        self.thread.start()

    def close(self):
        self.stop.set()
        self.thread.join(timeout=5)
        if self.thread.is_alive():
            raise RuntimeError("Observation recorder did not stop")


@contextmanager
def observe_pipeline(registry):
    """Wrap original decoder, adapter iterator and worker publish; restore on exit.

    Caller must join worker threads before leaving this process-scoped context.
    REST threads may use scoped(NetworkObservation()) independently.
    """
    original_feed = oanda_stream.NDJSONDecoder.feed
    original_stream = oanda_stream.OandaPractice.stream
    original_publish = oanda_worker.publish_event

    def feed(decoder, chunk):
        observation = getattr(_CURRENT, "observation", None)
        if observation is None:
            return original_feed(decoder, chunk)
        started = observation.clock()
        try:
            records = original_feed(decoder, chunk)
        except BaseException as error:
            observation.decoded(chunk, decoder, (), started, error=error)
            raise
        observation.decoded(chunk, decoder, records, started)
        return records

    def stream(adapter, identities, *, epoch, stopped=None):
        observation = registry.start(epoch)
        previous = getattr(_CURRENT, "observation", None)
        _CURRENT.observation = observation
        iterator = original_stream(adapter, identities, epoch=epoch, stopped=stopped)
        reason = "closed"
        try:
            with scoped(observation.network):
                while True:
                    started = observation.clock()
                    with observation.lock:
                        observation.data["next_active_since"] = started
                    try:
                        event = next(iterator)
                    except StopIteration:
                        reason = "eof"
                        return
                    finally:
                        with observation.lock:
                            observation.data["next_active_since"] = None
                            observation.data["next_max_ms"] = max(observation.data["next_max_ms"],
                                (observation.clock()-started)*1000)
                    observation.yielded(event)
                    yielded_at = observation.clock()
                    try:
                        yield event
                    finally:
                        elapsed = (observation.clock()-yielded_at)*1000
                        with observation.lock:
                            observation.data["consumer_total_ms"] += elapsed
                            observation.data["consumer_max_ms"] = max(
                                observation.data["consumer_max_ms"], elapsed)
        except GeneratorExit:
            raise
        except BaseException:
            reason = "error"
            raise
        finally:
            try:
                iterator.close()
            finally:
                observation.finish(reason)
                _CURRENT.observation = previous

    def publish(ownership, epoch, event, identities):
        observation = getattr(_CURRENT, "observation", None)
        if observation is None:
            return original_publish(ownership, epoch, event, identities)
        return observation.publish(original_publish, ownership, epoch, event, identities)

    with observe_network():
        oanda_stream.NDJSONDecoder.feed = feed
        oanda_stream.OandaPractice.stream = stream
        oanda_worker.publish_event = publish
        try:
            yield registry
        finally:
            oanda_stream.NDJSONDecoder.feed = original_feed
            oanda_stream.OandaPractice.stream = original_stream
            oanda_worker.publish_event = original_publish
