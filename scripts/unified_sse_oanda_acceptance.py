"""Task-owned workspace/watch and read-only real Practice state; never fake prices."""
import argparse
import json
from dataclasses import asdict
from decimal import Decimal

from alerts.config import settings
from alerts.domain import Rule
from alerts.history_catalog import account_scope
from alerts.live_pricing import desired_datasets
from alerts.storage import (
    AdvancedWorkspace,
    LiveState,
    MarketDataset,
    MarketStreamClient,
    MarketStreamSubscription,
    MarketStreamTask,
    Preference,
    Watch,
    now_ms,
    transaction,
)
from sqlalchemy import select
from unified_sse_acceptance_fixture import TASK, guard

WORKSPACE = "unified-sse-oanda-real"
WATCH = "unified-sse-oanda-independent-watch"
MARKER = "acceptance.unified-sse.oanda-real"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("seed", "state", "watch-on", "watch-off",
        "composite-seed", "composite-activate"))
    args = parser.parse_args()
    guard()
    if not settings.oanda_token or not settings.oanda_account_id or not settings.oanda_stream_enabled:
        raise SystemExit("Real Practice configuration required")
    scope = account_scope()
    if args.action in ("seed", "composite-seed"):
        from alerts.market_data import refresh_catalog

        refresh_catalog()
        if args.action == "composite-seed":
            from alerts.history_catalog import refresh_oanda

            refresh_oanda()
    with transaction() as db:
        dataset = next((row for row in db.scalars(select(MarketDataset)) if
            row.identity.get("account_scope") == scope and row.identity.get("provider_symbol") == "EUR_USD"
            and row.identity.get("calendar_version") == settings.oanda_calendar_version), None)
        if dataset is None:
            raise SystemExit("Wait for pricing worker real account catalog")
        marker = db.get(Preference, MARKER)
        if not marker:
            if args.action != "seed" or db.get(AdvancedWorkspace, WORKSPACE) or db.get(Watch, WATCH):
                raise SystemExit("Missing ownership marker")
            marker = Preference(key=MARKER, value={"task": TASK, "supplier": "oanda-practice",
                "instrument": dataset.instrument_id})
            db.add(marker)
        if marker.value != {"task": TASK, "supplier": "oanda-practice", "instrument": dataset.instrument_id}:
            raise SystemExit("Incompatible real supplier acceptance ownership")
        composite_marker = db.get(Preference, MARKER + ".composite")
        if args.action == "composite-seed" and not composite_marker:
            from alerts.history_versions import create_version

            end = (now_ms() - 5000) // 60000 * 60000
            version = create_version(db, dataset.id, end - 3 * 86400000, end)
            composite_marker = Preference(key=MARKER + ".composite", value={"task": TASK,
                "version": version, "history_dataset": dataset.id, "synthetic": False})
            db.add(composite_marker)
        if args.action == "composite-activate":
            from alerts.composite_definitions import first_use, save_mapping
            from alerts.storage import HistoryVersion, MarketCatalog

            if not composite_marker or composite_marker.value.get("task") != TASK:
                raise SystemExit("Missing task-owned real history version")
            if db.get(HistoryVersion, composite_marker.value["version"]).status != "published":
                raise SystemExit("Real supplier history version is still preparing")
            entry = next(row for row in db.scalars(select(MarketCatalog)) if
                row.symbol == "EUR_USD" and row.metadata_json.get("history_account_scope") == scope)
            mapping = save_mapping(db, dataset.id, entry.id, {
                "underlying": "EUR", "quote_currency": "USD", "historical_product": "spot_fx",
                "live_product": "spot_fx", "relationship": "same_product",
                "historical_evidence": "https://developer.oanda.com/rest-live-v20/instrument-ep/",
                "live_evidence": "https://developer.oanda.com/rest-live-v20/pricing-ep/",
                "rationale": "Same Practice account EUR_USD BID: real REST M1 fixed baseline and streaming tail",
                "reviewed": True})
            composite = first_use(db, dataset.id, mapping.id)
            composite_marker.value = {**composite_marker.value, "composite": composite.id}
            row = db.get(AdvancedWorkspace, WORKSPACE + "-composite")
            document = {"engine": "tv31", "schemaVersion": 1, "symbol": "MWC:" + composite.id,
                "series_kind": "composite", "interval": "1"}
            if not row:
                row = AdvancedWorkspace(id=WORKSPACE + "-composite", name="真实OANDA固定历史接实时组合",
                    document=document)
                db.add(row)
            else:
                row.document = document
                row.revision += 1
            row.updated_at = now_ms()
        if args.action == "seed":
            row = db.get(AdvancedWorkspace, WORKSPACE)
            document = {"engine": "tv31", "schemaVersion": 1, "symbol": "MWP:EURUSD",
                "series_kind": "provider", "interval": "1"}
            if not row:
                row = AdvancedWorkspace(id=WORKSPACE, name="统一 SSE · OANDA Practice 真实验收", document=document)
                db.add(row)
            else:
                row.document = document
                row.revision += 1
            row.updated_at = now_ms()
        watch = db.get(Watch, WATCH)
        if args.action == "watch-on":
            if not watch:
                rule = asdict(Rule(kind="price", timeframe="tick", level=Decimal("999999")))
                rule["level"] = str(rule["level"])
                watch = Watch(id=WATCH, instrument_id=dataset.instrument_id, name="隔离验收独立需求",
                    rule=rule, state={}, status="active", armed_at=now_ms(), paused_reason=None)
                db.add(watch)
            else:
                if watch.instrument_id != dataset.instrument_id:
                    raise SystemExit("Watch ownership changed")
                watch.status, watch.armed_at = "active", now_ms()
        elif args.action == "watch-off" and watch:
            watch.status = "paused"
        state = db.get(LiveState, dataset.id)
        consumers = [{"client": c, "kind": k, "instrument": i} for c, k, i in db.execute(
            select(MarketStreamClient.client, MarketStreamTask.identity["kind"].as_string(),
                MarketStreamTask.query["instrument"].as_string()).select_from(MarketStreamSubscription)
            .join(MarketStreamClient, MarketStreamClient.id == MarketStreamSubscription.client_id)
            .join(MarketStreamTask, MarketStreamTask.id == MarketStreamSubscription.task_id).where(
                MarketStreamSubscription.active.is_(True), MarketStreamSubscription.expires > now_ms()))]
        result = {"synthetic": False, "task": TASK, "workspace": WORKSPACE, "instrument": dataset.instrument_id,
            "live": {"revision": state.revision, "received_at": state.received_at,
                "confirmed_end": state.confirmed_end, "ready": state.ready, "connection": state.connection},
            "consumers": consumers, "watch_state": watch.state if watch else None,
            "watch_status": watch.status if watch else None}
        if args.action == "composite-activate":
            result["workspace"] = WORKSPACE + "-composite"
        if composite_marker:
            from alerts.storage import HistoryArtifact, HistoryVersion

            value = composite_marker.value
            result["real_history"] = {**value, "status": db.get(HistoryVersion,value["version"]).status,
                "artifacts": [{"frame": a.timeframe, "status": a.status} for a in db.scalars(
                    select(HistoryArtifact).where(HistoryArtifact.version_id == value["version"]))]}
    result["desired_symbols"] = list(desired_datasets(settings.oanda_account_id))
    print(json.dumps(result))


if __name__ == "__main__":
    main()
