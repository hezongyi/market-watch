"""Shared market calculation worker; API processes only deliver committed results."""

import copy
import logging
import signal
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from sqlalchemy import func, select

from . import market_stream as stream
from .chart_api import DataQuery, data_sync
from .chart_series import encode
from .composite_realtime import CurrentBuckets
from .storage import (
    Bar,
    CompositePreparation,
    CompositeRevision,
    FixedIndicatorRun,
    HistoryArtifact,
    HistoryVersion,
    Instrument,
    MarketComposite,
    MarketStreamTask,
    ProviderDataset,
    now_ms,
    transaction,
    uid,
)

log = logging.getLogger(__name__)


class Calculator:
    def __init__(self):
        self.buckets = CurrentBuckets()
        self.bucket_lock = threading.Lock()
        self.signals = {}
        self.provider_ready = set()
        self.computations = 0
        self.demand_at = {}

    def _demand(self, db, work, query):
        if query.series_kind not in ("managed", "composite"):
            return
        from .market_data import demand_id, renew_demand
        from .storage import MarketDemand
        if query.series_kind == "composite":
            composite = db.get(MarketComposite, query.instrument)
            inst = db.get(Instrument, composite.instrument_id)
            revision_id = query.composite_revision_id or composite.active_revision_id
        else:
            inst, revision_id = db.get(Instrument, query.instrument), None
        client = "stream:" + work["id"][:32]
        demand = db.get(MarketDemand, demand_id(client, inst.id, composite_revision_id=revision_id))
        if self.demand_at.get(work["id"], 0) > now_ms():
            if demand and demand.expires > now_ms():
                return
        if query.series_kind == "composite" and query.composite_revision_id is None and not demand:
            stream._release_demand(db, db.get(MarketStreamTask, work["id"]), keep_revision=revision_id)
        renew_demand(db, client, inst, composite_revision_id=revision_id)
        self.demand_at[work["id"]] = now_ms() + 30000

    def _signal(self, db, work, query):
        stamp = now_ms()
        kind, ident = query.series_kind, query.instrument
        if kind == "provider":
            from .provider_service import interest_id
            from .storage import ProviderInterest
            dataset = db.get(ProviderDataset, work["identity"]["dataset_id"])
            interest = db.get(ProviderInterest, interest_id("stream_" + work["id"][:32], "shared"))
            return [dataset.revision, dataset.metadata_json, interest.error if interest else None, stamp // 60000]
        if kind == "composite":
            from .composite_quotes import live_snapshot
            revision = db.get(CompositeRevision, query.composite_revision_id or
                              db.get(MarketComposite, ident).active_revision_id)
            prep = db.get(CompositePreparation, revision.id)
            live = live_snapshot(db, revision, now=stamp)
            from .storage import MarketDataset, RealtimeMapping
            target = db.get(MarketDataset, db.get(RealtimeMapping, revision.mapping_id).target_dataset_id)
            baseline = db.get(HistoryVersion, revision.history_version_id)
            return [revision.id, revision.rules, baseline.manifest, target.identity,
                    db.get(Instrument, target.instrument_id).calendar_profile,
                    prep.input_revision, prep.status, prep.cutoff, prep.confirmed_end,
                    live["current_account"], live["owned"], live["connection"], live["quote_ready"],
                    live["confirmed_tail_ready"], live["connection_epoch"], live["live_revision"],
                    stamp // 60000, self._indicators(db, revision_id=revision.id)]
        if kind == "history":
            version = db.get(HistoryVersion, ident)
            artifacts = list(db.execute(select(HistoryArtifact.timeframe, HistoryArtifact.status).where(
                HistoryArtifact.version_id == ident)))
            return [version.manifest, [list(r) for r in artifacts], self._indicators(db, version_id=ident)]
        inst = db.get(Instrument, ident)
        from .storage import ChartHistoryPlan, ChartPublication
        plan = db.get(ChartHistoryPlan, ident)
        preparation = [plan.status, plan.cursor, plan.target_start, plan.target_end,
                       plan.realtime_enabled, plan.realtime_end] if plan else None
        if query.published and work["identity"]["kind"] == "bars":
            # Published native data depends on its atomic publication, not on
            # every staging candle. This primary-key read is independent of
            # the amount of retained acquisition history.
            publication = db.get(ChartPublication, (ident, query.timeframe))
            facts = [publication.start, publication.end, publication.revision,
                     publication.initialized, publication.complete_count] if publication else None
        else:
            facts = list(db.execute(select(func.count(Bar.id), func.max(Bar.received_at),
                func.sum(Bar.revision + Bar.volume_revision)).where(Bar.instrument_id == ident)).one())
        return [facts, inst.calendar_profile, preparation, stamp // 60000]

    @staticmethod
    def _indicators(db, *, revision_id=None, version_id=None):
        query = select(FixedIndicatorRun.id, FixedIndicatorRun.cursor, FixedIndicatorRun.status)
        query = query.where(FixedIndicatorRun.revision_id == revision_id) if revision_id else query.where(
            FixedIndicatorRun.history_version_id == version_id)
        return [list(r) for r in db.execute(query)]

    def build(self, work):
        query = DataQuery.model_validate(work["query"])
        identity = work["identity"]
        if query.series_kind == "provider":
            from .provider_cache import identity as provider_identity
            if provider_identity(identity["metadata"], query.timeframe if identity["kind"] == "bars" else "M1") != identity["dataset_id"]:
                return {"type": "reset", "reason": "account_changed"}, 2000
        with transaction() as db:
            self._demand(db, work, query)
        if identity["kind"] == "quotes":
            from .market_data import QuoteQuery, quote_snapshot
            from .provider_capabilities import poll_seconds
            source = identity["metadata"]["source"]
            delay = poll_seconds(source) * 1000 if query.series_kind == "provider" else 500
            if query.series_kind != "provider":
                with transaction() as db:
                    signal_value = stream.digest(self._signal(db, work, query))
                if work.get("input_signal") == signal_value:
                    return None, delay
            rows = quote_snapshot(QuoteQuery(symbols=[encode(query.instrument, query.series_kind)],
                composite_revision_id=query.composite_revision_id, input_revision=query.input_revision))
            # Age is status evidence, not a new price result every half second.
            for row in rows:
                row.pop("age_ms", None)
                if row.get("snapshot"):
                    row["snapshot"].pop("queried_at", None)
            self.computations += 1
            if query.series_kind != "provider":
                self.signals[work["id"]] = signal_value
                work["new_input_signal"] = signal_value
            return {"type": "quotes", "quotes": rows}, delay
        if query.series_kind == "provider":
            from .provider_service import interest_id, renew, subscribe
            from .storage import ProviderInterest
            worker_client, listener = "stream_" + work["id"][:32], "shared"
            with transaction() as db:
                registered = db.get(ProviderInterest, interest_id(worker_client, listener)) is not None
            if not registered:
                subscribe(worker_client, listener, query.instrument, query.timeframe, indicators=query.indicators)
                self.provider_ready.add(work["id"])
            renew(worker_client)
        with transaction() as db:
            signal_value = stream.digest(self._signal(db, work, query))
        if work.get("input_signal") == signal_value:
            return None, 500
        if query.series_kind in ("composite", "history"):
            from .series_access import chart_data
            with self.bucket_lock:
                with transaction() as db:
                    page = chart_data(db, query, realtime=self.buckets)
        elif query.series_kind == "provider":
            from .chart_calculation_history import calculation_rows
            from .chart_indicators import calculate
            from .provider_cache import snapshot
            from .storage import ProviderBar
            page = snapshot(identity["dataset_id"], now_ms() + 1, 2000)
            from .provider_service import interest_id
            from .storage import ProviderInterest
            with transaction() as db:
                interest = db.get(ProviderInterest, interest_id("stream_" + work["id"][:32], "shared"))
                page["status"] = {"state": "error" if interest and interest.error else "ready",
                                  "error": "平台行情暂不可用，后台重试中" if interest and interest.error else None}
            if query.indicators and page["bars"]:
                with transaction() as db:
                    dataset = db.get(ProviderDataset, identity["dataset_id"])
                    inputs = list(db.scalars(select(ProviderBar).where(
                        ProviderBar.dataset_id == dataset.id).order_by(ProviderBar.chart_time)))
                    page["indicators"] = [calculate(calculation_rows(
                        [r.payload for r in inputs if spec.get("calculation_origin") is None or
                         r.start >= spec["calculation_origin"]], dataset.metadata_json, query.instrument),
                        spec, provisional=query.provisional) for spec in query.indicators]
        else:
            page = data_sync(query)
        self.signals[work["id"]] = signal_value
        work["new_input_signal"] = signal_value
        self.computations += 1
        page.pop("as_of", None)
        page.pop("future", None)
        page["resolved_revision_id"] = page.get("revision_id")
        if query.series_kind == "composite":
            from .composite_quotes import live_snapshot
            with transaction() as db:
                revision = db.get(CompositeRevision, page["revision_id"])
                state = live_snapshot(db, revision)
                page["status"] = {key: state[key] for key in (
                    "quote_ready", "confirmed_tail_ready", "owned", "connection", "current_account")}
        return {"type": "bars", **page}, 500

    def retire_memory(self):
        with transaction() as db:
            live = set(db.scalars(select(MarketStreamTask.id).where(MarketStreamTask.expires > now_ms())))
        for key in list(self.signals):
            if key not in live:
                self.signals.pop(key)
        self.provider_ready.intersection_update(live)


def calculate_work(calculator, work):
    try:
        payload, delay = calculator.build(work)
    except Exception as error:
        log.warning("market calculation failed: %s", type(error).__name__)
        payload, delay = {"type": "status", "status": "error", "error": "行情暂不可用，后台重试中"}, 2000
        calculator.signals.pop(work["id"], None)
    try:
        stream.commit(work, copy.deepcopy(payload), delay_ms=delay)
    except Exception:
        # A successful build that failed publication must not suppress the next
        # owner's retry just because this process remembers its input signal.
        calculator.signals.pop(work["id"], None)
        raise
    return True


def tick(calculator):
    work = stream.claim()
    return calculate_work(calculator, work) if work else False


def main():
    stopped = threading.Event()
    for name in (signal.SIGTERM, signal.SIGINT):
        signal.signal(name, lambda *_: stopped.set())
    calculators, pending = {}, {}
    shared_buckets = {}
    owner = uid()
    cleanup_at = 0
    # Fixed in-flight budget. A supplier quote or expensive first bucket does
    # not serialize every other task behind it; SSE never waits on these slots.
    with ThreadPoolExecutor(max_workers=4, thread_name_prefix="market-stream") as executor:
        while not stopped.is_set():
            worked = False
            try:
                for key, future in list(pending.items()):
                    if future.done():
                        pending.pop(key)
                        try:
                            future.result()
                        except Exception as error:
                            log.warning("market task failed: %s", type(error).__name__)
                if len(pending) < 4:
                    work = stream.claim(exclude=pending, owner=owner)
                    if work:
                        key = work["id"]
                        calculator = calculators.pop(key, None) or Calculator()
                        identity = work["identity"]
                        if identity["series_kind"] == "composite" and identity["kind"] == "bars":
                            base_key = (identity["instrument"], identity.get("revision_id"), identity["timeframe"])
                            shared = shared_buckets.pop(base_key, None) or (CurrentBuckets(), threading.Lock())
                            shared_buckets[base_key] = shared
                            calculator.buckets, calculator.bucket_lock = shared
                        calculators[key] = calculator
                        pending[key] = executor.submit(calculate_work, calculator, work)
                        worked = True
                if time.monotonic() >= cleanup_at:
                    stream.cleanup()
                    with transaction() as db:
                        live = set(db.scalars(select(MarketStreamTask.id).where(MarketStreamTask.expires > now_ms())))
                    for key in list(calculators):
                        if key not in pending and (key not in live or len(calculators) > 256):
                            calculators.pop(key)
                    while len(shared_buckets) > 256:
                        shared_buckets.pop(next(iter(shared_buckets)))
                    cleanup_at = time.monotonic() + 30
            except Exception as error:
                log.warning("market worker failed: %s", type(error).__name__)
            stopped.wait(.01 if worked else .1)


if __name__ == "__main__":
    main()
