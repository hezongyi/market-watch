"""Track C acceptance fixtures: real shapes through the application paths.

One isolated instance (project mw-track-c-20261028) owns this database. The
script never writes another project's rows and refuses to re-seed an already
seeded database, so a repeated run is a no-op instead of a duplicate graph.

Timeline (all UTC minute boundaries, anchored on the seed's own clock):

* composite A (EURUSD, ny17): fixed history ends 40 days ago, live confirmed
  minutes run from its seam to now, so ~10 days of them fall outside the
  30-day retention window and ~30 days inside it.
* composite A's newest published history version (forward-only, same calendar
  and price basis) is the candidate the Sunday shadow prepares.
* composite B (GBPUSD, ny17) plus a derived utc0 dataset: the calendar-change
  candidate that activation must pause instead of relocating.
"""

import argparse
import json
import math
import sys

from alerts import composite_aggregates, composite_preparation, retention_window, storage
from alerts.chart_alert_service import AlertConfig, create as create_alert
from alerts.chart_alert_worker import evaluate as evaluate_alert
from alerts.chart_data import FRAMES
from alerts.composite_definitions import first_use, save_mapping
from alerts.config import settings
from alerts.history_artifacts import artifact_tick
from alerts.history_catalog import account_scope
from alerts.history_versions import create_version, import_page
from alerts.live_pricing import account_key
from alerts.market_contracts import CandleBatch, DatasetIdentity, MinuteRow, RequestResult
from alerts.market_datasets import register_dataset
from alerts.realtime_switch import set_enabled
from alerts.storage import (
    ChartAlert,
    ChartAlertVersion,
    CompositeAggregateTask,
    CompositeJudgment,
    CompositePreparation,
    CompositeRevision,
    HistoryArtifact,
    HistoryVersion,
    LiveState,
    MarketCatalog,
    MarketComposite,
    MarketDataset,
    Preference,
    PricingOwner,
    RealtimeMapping,
    SourceMinute,
    transaction,
    now_ms,
)
from sqlalchemy import select

MIN = 60_000
DAY = 24 * 60 * MIN
STEP = 15 * MIN          # sparse live grid outside the dense tail
DENSE = 2 * DAY          # every minute for the last two days (bar coverage)
STATE_KEY = "track_c_acceptance:state"
LINE = "1.1030"
WAVE_PERIOD = 6 * 60 * MIN
WAVE_MILLI = 60000       # 0.006 around 1.1000


def price_at(stamp):
    """Deterministic bid price; a pure function of the minute it belongs to."""
    return round(1.1000 + 0.006 * math.sin(2 * math.pi * stamp / WAVE_PERIOD), 5)


def is_dense(stamp, end):
    return stamp >= end - DENSE


def rows_for(start, end, *, dense_end):
    """Confirmed M1 rows on the same grid a re-read would return."""
    out, at = [], start
    while at < end:
        p = price_at(at)
        out.append(MinuteRow(timestamp=at, open=f"{p - 0.0002:.5f}", high=f"{p + 0.0004:.5f}",
                             low=f"{p - 0.0004:.5f}", close=f"{p:.5f}", volume="4.0", complete=True))
        at += MIN if is_dense(at, dense_end) else STEP
    return tuple(out)


def last_cross_up(end):
    """The most recent minute where the wave crosses the line upwards."""
    period = WAVE_PERIOD
    offset = period // 12          # sin = 0.5 while ascending
    stamp = (end // period) * period + offset
    while stamp + 2 * MIN > end:
        stamp -= period
    return stamp


class AcceptanceAdapter:
    """The provider page the acceptance re-reads; no network, identical bytes."""

    def __init__(self, dense_end, volume=None):
        self.dense_end = dense_end
        self.volume = volume
        self.calls = []

    def page(self, identity, start, end):
        self.calls.append((start, end))
        # The declared volume semantics belong to the source the page comes from.
        volume = self.volume or (("price_count", "quotes") if identity.source == "oanda"
                                 else ("quantity", "source_quantity"))
        return CandleBatch(identity=identity, window_start=start, window_end=end,
                           observed_at=end + 1, checkpoint=end,
                           result=RequestResult(status="data"),
                           rows=rows_for(start, end, dense_end=self.dense_end),
                           volume_kind=volume[0], volume_unit=volume[1])


def _identity(symbol, calendar_version="candidate-ny17-v1"):
    return DatasetIdentity(source="dukascopy", channel="python", environment="historical",
                           account_scope="public", provider_symbol=symbol, basis="bid",
                           calendar_version=calendar_version)


PROOF = {
    "underlying": "EUR" if True else "", "quote_currency": "USD",
    "historical_product": "spot_fx", "live_product": "spot_fx",
    "relationship": "same_product",
    "historical_evidence": "https://www.dukascopy.com/swiss/english/marketwatch/historical/",
    "live_evidence": "https://developer.oanda.com/rest-live-v20/pricing-ep/",
    "rationale": "Explicitly reviewed Bid prices of the same spot product in both products",
    "reviewed": True,
}


def _proof(underlying, quote):
    return {**PROOF, "underlying": underlying, "quote_currency": quote}


def register_series(symbol, logical, calendar, catalog_symbol, precision=5):
    ident = _identity(symbol)
    with transaction() as db:
        instrument = register_dataset(db, ident, logical_symbol=logical, label=logical,
                                      calendar=calendar, precision=precision,
                                      volume_kind="quantity", volume_unit="source_quantity")
        catalog = "HC:" + logical.lower().replace("/", "") + "-" + calendar
        if db.get(MarketCatalog, catalog) is None:
            db.add(MarketCatalog(id=catalog, source="oanda", symbol=catalog_symbol,
                                 label=logical, asset_type="CURRENCY", precision=precision,
                                 calendar=calendar,
                                 metadata_json={"history_account_scope": account_scope()}))
        return {"dataset": ident.key, "instrument": instrument.id, "catalog": catalog}


def publish_history(dataset_id, start, end, dense_end, *, step=30 * MIN):
    """One published fixed-history version with every frame artifact readable."""
    with transaction() as db:
        version = create_version(db, dataset_id, start, end)
    adapter = AcceptanceAdapter(dense_end)
    original = adapter.page

    def page(identity, window_start, window_end):
        batch = original(identity, window_start, window_end)
        return batch.model_copy(update={"rows": tuple(MinuteRow(**{
            **row.model_dump(),
            "timestamp": window_start + index * step,
        }) for index, row in enumerate(batch.rows)
            if window_start + index * step < window_end)})

    class HistoryAdapter:
        def page(self, identity, a, b):
            return page(identity, a, b)

    while import_page(HistoryAdapter(), version_id=version):
        pass
    _wait_frames(version)
    with transaction() as db:
        row = db.get(HistoryVersion, version)
        if row.status != "published":
            raise RuntimeError("history version not published: " + str(row.error))
        return {"version": version, "start": row.start, "end": row.end}


def _wait_frames(version_id, *, timeout=120.0, report_rounds=False):
    """Publish every frame of one history version, tolerating a concurrent worker.

    A running data-worker holds the pending artifact row while it works, and
    artifact_tick skips locked rows, so this waits for M1 instead of assuming
    the first tick did the job.
    """
    import time

    from alerts.composite_revisions import request_artifacts

    deadline = time.time() + timeout
    rounds = 0
    requested = False
    while time.time() < deadline:
        with transaction() as db:
            published = {row.timeframe for row in db.scalars(select(HistoryArtifact).where(
                HistoryArtifact.version_id == version_id, HistoryArtifact.status == "published"))}
        if set(FRAMES) <= published:
            return rounds if not report_rounds else rounds
        if "M1" in published and not requested:
            try:
                with transaction() as db:
                    request_artifacts(db, db.get(HistoryVersion, version_id), FRAMES)
                requested = True
            except ValueError:
                pass
        if artifact_tick(version_id):
            rounds += 1
        else:
            time.sleep(0.2)
    raise RuntimeError("history artifacts did not converge: " + str(version_id))


def prepare(revision_id, dense_end, limit=20):
    """Drive the bounded preparation reads until the fixed tail is queried."""
    with transaction() as db:
        # Clear a previous bounded retry backoff so the acceptance read resumes.
        pending = db.get(CompositePreparation, revision_id)
        if pending and pending.status in ("retrying", "configuration_error") \
                and (pending.cursor or 0) < pending.cutoff:
            pending.status, pending.error, pending.next_at = "pending", None, 0
            pending.lease_token, pending.lease_until = None, 0
    commits = 0
    for _ in range(limit):
        owned = composite_preparation.claim(revision_id)
        if owned is None:
            break
        identity = DatasetIdentity.model_validate(owned["identity"])
        batch = CandleBatch(identity=identity, window_start=owned["start"],
                            window_end=owned["end"], observed_at=now_ms(), checkpoint=owned["end"],
                            result=RequestResult(status="data"),
                            rows=rows_for(owned["start"], owned["end"], dense_end=dense_end),
                            volume_kind="price_count", volume_unit="quotes")
        composite_preparation.commit(owned, batch)
        commits += 1
    with transaction() as db:
        prep = db.get(CompositePreparation, revision_id)
        return {"commits": commits, "status": prep.status, "cursor": prep.cursor,
                "cutoff": prep.cutoff, "input_revision": prep.input_revision,
                "confirmed_end": prep.confirmed_end}


def drain(revision_id):
    """Run the period aggregate tasks until every frame covers the input."""
    for frame in FRAMES:
        for _ in range(4000):
            if not composite_aggregates.aggregate_tick(revision_id, frame):
                break
        else:
            raise RuntimeError("aggregate task did not finish: " + frame)
    with transaction() as db:
        prep = db.get(CompositePreparation, revision_id)
        tasks = {task.timeframe: task.applied_input_revision for task in db.scalars(
            select(CompositeAggregateTask).where(CompositeAggregateTask.revision_id == revision_id))}
        return {"input_revision": prep.input_revision, "tasks": tasks}


def settle(revision_id, rounds=6):
    """Freeze the activation input and finish period/indicator preparation."""
    from alerts.composite_revisions import preparation_tick, readiness

    progress = None
    for _ in range(rounds):
        preparation_tick()
        drain(revision_id)
        with transaction() as db:
            progress = readiness(db, db.get(CompositeRevision, revision_id))
        if progress["ready"]:
            return progress
    return progress


def live_source(revision_id, stamp):
    """Fix one owned, fresh quote so a composite rule can be created at all."""
    with transaction() as db:
        revision = db.get(CompositeRevision, revision_id)
        target_id = db.get(RealtimeMapping, revision.mapping_id).target_dataset_id
        key = account_key(settings.oanda_account_id)
        owner = db.get(PricingOwner, key) or PricingOwner(id=key)
        owner.token, owner.expires, owner.epoch = "track-c-acceptance", stamp + 60000, 1
        db.add(owner)
        state = db.get(LiveState, target_id) or LiveState(dataset_id=target_id)
        state.ready, state.connection, state.epoch = True, "connected", 1
        state.heartbeat_at = state.received_at = stamp
        state.confirmed_end, state.error = stamp, None
        state.quote = {"source_time": stamp, "bid": str(price_at(stamp)),
                       "ask": str(price_at(stamp) + 0.0002), "tradeable": True,
                       "connection_epoch": 1}
        db.add(state)
        db.flush()
    with transaction() as db:
        revision = db.get(CompositeRevision, revision_id)
        dataset = db.get(MarketDataset, db.get(HistoryVersion, revision.history_version_id).dataset_id)
        set_enabled(db, dataset.instrument_id, True, now=stamp)
    return {"target": target_id, "stamp": stamp}


def composite_rule(composite_id, revision_id, name, stamp):
    """An active composite rule with a drawn line condition and its geometry."""
    config = AlertConfig.model_validate({
        "name": name, "instrument": composite_id, "series_kind": "composite",
        "source": "composite", "timeframe": "M1", "mode": "close", "max_triggers": 3,
        "composite_revision_id": revision_id,
        "condition": {"relation": "cross_up", "left": {"kind": "price"},
                      "right": {"kind": "line", "line": {"kind": "horizontal_line", "points": [
                          {"time": stamp - MIN, "index": 0, "price": LINE}]}}},
    })
    with transaction() as db:
        return create_alert(db, name, config, at=stamp).id


def judge(alert_id, stamp):
    """One real judgment round at the acceptance clock."""
    with transaction() as db:
        written = evaluate_alert(db, alert_id, clock=lambda: stamp)
        alert = db.get(ChartAlert, alert_id)
        rows = list(db.scalars(select(CompositeJudgment).join(
            ChartAlertVersion, ChartAlertVersion.id == CompositeJudgment.alert_version_id).where(
                ChartAlertVersion.alert_id == alert_id).order_by(CompositeJudgment.event_time)))
    return {"alert_id": alert_id, "clock": stamp, "emitted": len(written),
            "health": alert.health, "reason": alert.health_reason, "status": alert.status,
            "judgments": len(rows), "outcomes": sorted({row.outcome for row in rows}),
            "signals": len([row for row in rows if row.signal_id]),
            "events": [{"event_time": row.event_time, "outcome": row.outcome,
                        "signal_id": row.signal_id} for row in rows[-5:]],
            "runtime": alert.runtime}


def state():
    with transaction() as db:
        row = db.get(Preference, STATE_KEY)
        return dict(row.value) if row else None


def save_state(value):
    with transaction() as db:
        row = db.get(Preference, STATE_KEY)
        if row is None:
            db.add(Preference(key=STATE_KEY, value=value))
        else:
            row.value = value


def counts():
    """Row counts the acceptance asserts on (window, history tables, dedupe)."""
    from alerts.storage import (Bar, HistoryArtifact, HistoryChunk, Notification, Outbox)
    with transaction() as db:
        lower = retention_window.lower_bound()
        return {
            "source_minutes_old": int(db.scalar(select(__import__("sqlalchemy").func.count())
                .select_from(SourceMinute).where(SourceMinute.start < lower)) or 0),
            "source_minutes_recent": int(db.scalar(select(__import__("sqlalchemy").func.count())
                .select_from(SourceMinute).where(SourceMinute.start >= lower)) or 0),
            "bars": int(db.scalar(select(__import__("sqlalchemy").func.count())
                .select_from(Bar)) or 0),
            "history_chunks": int(db.scalar(select(__import__("sqlalchemy").func.count())
                .select_from(HistoryChunk)) or 0),
            "history_artifacts": int(db.scalar(select(__import__("sqlalchemy").func.count())
                .select_from(HistoryArtifact)) or 0),
            "notifications": int(db.scalar(select(__import__("sqlalchemy").func.count())
                .select_from(Notification)) or 0),
            "outbox": int(db.scalar(select(__import__("sqlalchemy").func.count())
                .select_from(Outbox)) or 0),
        }


def build(symbol, logical, calendar, catalog_symbol, underlying, quote, *, end_days, dense_end):
    series = register_series(symbol, logical, calendar, catalog_symbol)
    history = publish_history(series["dataset"], end_days[0], end_days[1], dense_end)
    with transaction() as db:
        mapping = save_mapping(db, series["dataset"], series["catalog"], _proof(underlying, quote))
        composite = first_use(db, series["dataset"], mapping.id)
        revision = db.get(CompositeRevision, composite.active_revision_id)
        prep = db.get(CompositePreparation, revision.id)
        spec = {"composite": composite.id, "revision": revision.id, "seam": revision.seam,
                "mapping": mapping.id, "target": mapping.target_dataset_id,
                "cutoff": prep.cutoff, "history_version": history["version"],
                "rules": revision.rules}
    spec["preparation"] = prepare(spec["revision"], dense_end)
    spec["aggregates"] = drain(spec["revision"])
    return series, spec


def seed():
    if state():
        return {"skipped": True, "state": state()}
    stamped = now_ms()
    end = stamped // MIN * MIN
    dense_end = end
    a1_start = end - 40 * DAY
    b1_start = end - 40 * DAY
    a_series, a = build("EUR/USD", "EURUSD", "ny17", "EUR_USD", "EUR", "USD",
                        end_days=(a1_start - 3 * DAY, a1_start), dense_end=dense_end)
    b_series, b = build("USD/CAD", "USDCAD", "ny17", "USD_CAD", "USD", "CAD",
                        end_days=(b1_start - 3 * DAY, b1_start), dense_end=dense_end)
    cross = last_cross_up(end)
    below, above = cross - 2 * MIN, cross + 2 * MIN
    live_source(a["revision"], below)
    live_source(b["revision"], end - MIN)
    a_alert = composite_rule(a["composite"], a["revision"], "组合穿越 1.1030", below)
    b_alert = composite_rule(b["composite"], b["revision"], "组合穿越 1.1030 (CAD)", end - MIN)
    # Consecutive bars only: a crossing is a step between neighbouring closes.
    first, second = [], []
    for at in range(below - 2 * MIN, above + MIN, MIN):
        live_source(a["revision"], at)
        (first if at <= below else second).append(judge(a_alert, at))
    forward = publish_history(a_series["dataset"], a1_start, end - 20 * DAY, dense_end)
    value = {"seeded_at": stamped, "clock": end, "line": LINE,
             "a": {**a, "alert": a_alert, "series": a_series},
             "b": {**b, "alert": b_alert, "series": b_series},
             "cross_up": cross, "judged_at": [below, above],
             "forward_version": forward["version"]}
    save_state(value)
    return {"skipped": False, "state": value,
            "judgment": {"below": first, "above": second}, "counts": counts()}


def build_utc_candidate():
    """The calendar-change candidate for composite B; explicit, never shadowed."""
    from alerts.aggregation_policy import change_aggregation
    from alerts.composite_revisions import create as create_revision, options

    saved = state()
    if saved.get("utc0", {}).get("revision"):
        ident = saved["utc0"]["revision"]
        prep = prepare(ident, saved["clock"])
        agg = drain(ident)
        progress = settle(ident)
        saved["utc0"].update({"preparation": prep, "aggregates": agg, "readiness": progress})
        save_state(saved)
        return {"revision": ident, "seam": saved["utc0"]["seam"], "reused": True,
                "preparation": prep, "aggregates": agg, "readiness": progress}
    with transaction() as db:
        destination, instrument, derived = change_aggregation(
            db, saved["b"]["series"]["dataset"], "utc0",
            version_id=saved["b"]["history_version"])
        utc_dataset, utc_instrument = destination.id, instrument.id
        utc_version = derived.id if derived is not None else None
    while import_page(AcceptanceAdapter(saved["clock"]), version_id=utc_version):
        with transaction() as db:
            if db.get(HistoryVersion, utc_version).status == "published":
                break
    from alerts.composite_revisions import request_artifacts

    with transaction() as db:
        request_artifacts(db, db.get(HistoryVersion, utc_version), FRAMES)
    for _ in range(2000):
        if not artifact_tick(utc_version):
            break
    with transaction() as db:
        utc_mapping = save_mapping(db, utc_dataset, saved["b"]["series"]["catalog"],
                                   _proof("USD", "CAD"))
        mapping_id = utc_mapping.id
        items = options(db, saved["b"]["composite"])["items"]
        chosen = next(item for item in items if item["version_id"] == utc_version)
        seam = chosen["recommended_seam"]
        revision = create_revision(db, saved["b"]["composite"], {
            "request_id": "acceptance-utc0-candidate",
            "expected_revision_id": saved["b"]["revision"],
            "history_version_id": utc_version,
            "mapping_id": mapping_id,
            "seam": seam,
            "reason": "验收：日历不同（utc0）的修订用于暂停分支",
        })
        ident = revision.id
    prep = prepare(ident, saved["clock"])
    agg = drain(ident)
    progress = settle(ident)
    saved["utc0"] = {"dataset": utc_dataset, "instrument": utc_instrument, "mapping": mapping_id,
                     "version": utc_version, "revision": ident, "seam": seam,
                     "preparation": prep, "aggregates": agg, "readiness": progress}
    save_state(saved)
    return {"revision": ident, "seam": seam, "preparation": prep, "readiness": progress,
            "dataset": utc_dataset, "version": utc_version}


def publish_forward(end_days, key, start_days=40):
    saved = state()
    end = saved["clock"] - end_days * DAY
    history = publish_history(saved["a"]["series"]["dataset"],
                              saved["clock"] - start_days * DAY, end, saved["clock"])
    saved.setdefault("versions", {})[key] = history["version"]
    save_state(saved)
    return history


def publish_frames(version_id):
    """Finish every frame artifact of one already published history version."""
    rounds = _wait_frames(version_id, report_rounds=True)
    with transaction() as db:
        frames = {row.timeframe: row.status for row in db.scalars(
            select(HistoryArtifact).where(HistoryArtifact.version_id == version_id))}
    return {"version": version_id, "rounds": rounds, "frames": frames,
            "published": sorted(name for name, status in frames.items()
                                if status == "published")}


def isolate():
    """Keep the Sunday loop scoped to composite A; B only proves the pause branch."""
    saved = state()
    with transaction() as db:
        revision = db.get(CompositeRevision, saved["b"]["revision"])
        dataset = db.get(MarketDataset, db.get(HistoryVersion, revision.history_version_id).dataset_id)
        set_enabled(db, dataset.instrument_id, False, now=now_ms())
        return {"instrument": dataset.instrument_id, "realtime_enabled": False}


def advance_candidate_input():
    """Give the failure candidate fresh input without catching its aggregates up."""
    saved = state()
    run = saved.get("failure_candidate")
    if not run:
        raise RuntimeError("no failure candidate recorded")
    revision_id = run["revision"]
    with transaction() as db:
        prep = db.get(CompositePreparation, revision_id)
        revision = db.get(CompositeRevision, revision_id)
        target = db.get(MarketDataset, db.get(RealtimeMapping, revision.mapping_id).target_dataset_id)
        identity = DatasetIdentity.model_validate(target.identity)
        start, stop = prep.confirmed_end, prep.confirmed_end + 3 * DAY
    batch = CandleBatch(identity=identity, window_start=start, window_end=stop,
                        observed_at=now_ms(), checkpoint=stop,
                        result=RequestResult(status="data"),
                        rows=rows_for(start, stop, dense_end=saved["clock"]),
                        volume_kind="price_count", volume_unit="quotes")
    from alerts.composite_inputs import apply_minutes
    from alerts.confirmed_minutes import record
    with transaction() as db:
        applied = apply_minutes(db, record(db, batch), revision_id=revision_id,
                                reason="acceptance-late-input")
    with transaction() as db:
        prep = db.get(CompositePreparation, revision_id)
        tasks = {task.timeframe: task.applied_input_revision for task in db.scalars(
            select(CompositeAggregateTask).where(CompositeAggregateTask.revision_id == revision_id))}
    return {"applied": [item for item in applied if item["revision_id"] == revision_id],
            "input_revision": prep.input_revision, "tasks": tasks}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage", default="fixtures",
                        choices=("fixtures", "utc-candidate", "counts", "state", "judge",
                                 "version3", "version4", "version5", "version6", "version7",
                                 "forward", "frames", "break", "isolate"))
    parser.add_argument("--alert", help="alert id for the judge stage")
    parser.add_argument("--version", help="history version id for the frames stage")
    parser.add_argument("--days", type=float, default=5)
    parser.add_argument("--start-days", type=float, default=40)
    parser.add_argument("--key", default="forward")
    parser.add_argument("--stamp", type=int, help="explicit acceptance clock")
    args = parser.parse_args(argv)
    if args.stage == "fixtures":
        result = seed()
    elif args.stage == "utc-candidate":
        result = build_utc_candidate()
    elif args.stage == "counts":
        result = counts()
    elif args.stage == "state":
        result = state()
    elif args.stage == "judge":
        result = judge(args.alert, args.stamp or state()["clock"] - MIN)
    elif args.stage == "version3":
        result = publish_forward(12, "v3")
    elif args.stage == "version4":
        result = publish_forward(6, "v4")
    elif args.stage == "version5":
        result = publish_forward(4, "v5")
    elif args.stage == "forward":
        result = publish_forward(args.days, args.key, start_days=args.start_days)
    elif args.stage == "version7":
        # A later fixed-history start: the deliberate case a rule bound earlier
        # cannot be relocated onto, which the shadow must report as will_pause.
        result = publish_forward(5, "v7late", start_days=30)
    elif args.stage == "version6":
        # A 30-day seam keeps the candidate preparation slow enough to change an
        # in-scope binding while the shadow run is still comparing.
        result = publish_forward(30, "v6")
    elif args.stage == "isolate":
        result = isolate()
    elif args.stage == "frames":
        result = publish_frames(args.version)
    else:
        result = advance_candidate_input()
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
