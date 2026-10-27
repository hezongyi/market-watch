"""Synthetic composite inputs in the guarded, credential-free Ubuntu task.

This feeds real immutable history, confirmed-input and pricing-owner writers.
It is not evidence of supplier observations or an economic source mapping.
"""

import argparse
import json
from decimal import Decimal

from alerts import live_pricing
from alerts.chart_data import FRAMES
from alerts.chart_series import encode
from alerts.composite_definitions import first_use, key
from alerts.composite_inputs import apply_minutes
from alerts.confirmed_minutes import record
from alerts.history_catalog import account_scope
from alerts.history_versions import create_version, publish
from alerts.market_contracts import CandleBatch, DatasetIdentity, MinuteRow, QuoteEvent
from alerts.market_datasets import register_dataset
from alerts.source_history_store import store_blob
from alerts.source_registry import collection_identity
from alerts.storage import (
    AdvancedWorkspace,
    CompositeMinute,
    CompositePreparation,
    CompositeRevision,
    HistoryArtifact,
    HistoryChunk,
    HistoryVersion,
    Instrument,
    LiveState,
    MarketDataset,
    Preference,
    PricingOwner,
    RealtimeMapping,
    now_ms,
    transaction,
)
from sqlalchemy import select
from unified_sse_acceptance_fixture import TASK, guard, settings

MARKER = "acceptance.unified-sse.composite"
WORKSPACE = "unified-sse-composite-synthetic"
WIDTH = 60000


def minute(at, close="1.11", *, volume="3"):
    return MinuteRow(timestamp=at,open="1.10",high="1.12",low="1.09",
                     close=close,volume=volume,complete=True)


def seed(db):
    historical = DatasetIdentity(source="dukascopy",channel="python",environment="historical",
        account_scope="public",provider_symbol="EUR/USD",basis="bid",calendar_version=TASK+"-synthetic")
    target = DatasetIdentity(source="oanda",channel="v20",environment="practice",
        account_scope=account_scope(),provider_symbol="EUR_USD",basis="bid",calendar_version=TASK+"-synthetic")
    # Synthetic identities are never configured for supplier acquisition.
    for identity,volume,unit in ((historical,"quantity","source_quantity"),(target,"price_count","quotes")):
        register_dataset(db,identity,logical_symbol="SSECOMP",label="SSE 合成组合输入",
            calendar="utc0",precision=5,volume_kind=volume,volume_unit=unit)
    end = now_ms() // WIDTH * WIDTH - 5000 * WIDTH
    start = end - 3000 * WIDTH
    version_id = create_version(db,historical.key,start,end)
    raw = json.dumps([minute(at,volume="2").model_dump() for at in range(start,end,WIDTH)],
                     sort_keys=True,separators=(",",":")).encode()
    content_id,checksum = store_blob(db,collection_identity(historical).key,raw)
    db.add(HistoryChunk(version_id=version_id,start=start,end=end,observed_at=now_ms(),
        count=3000,checksum=checksum,content=b"",content_id=content_id,result="data",unknown=[]))
    db.flush()
    version = db.get(HistoryVersion,version_id)
    version.cursor = end
    publish(db,version)
    from alerts.history_artifacts import request_artifacts

    request_artifacts(db,version,FRAMES)
    mapping_id = key({"synthetic":TASK,"history":historical.key,"target":target.key})
    db.add(RealtimeMapping(id=mapping_id,dataset_id=historical.key,target_dataset_id=target.key,
        permission_scope="workspace:default",match={"synthetic":True,"task":TASK}))
    db.add(LiveState(dataset_id=target.key))
    value = {"task":TASK,"synthetic":True,"version":version_id,"history":historical.key,
             "target":target.key,"mapping":mapping_id}
    db.add(Preference(key=MARKER,value=value))
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action",choices=("seed","activate","state","quote","expire"))
    parser.add_argument("--bid",type=Decimal,default=Decimal("1.12"))
    args = parser.parse_args()
    guard()
    if settings.oanda_account_id or settings.oanda_token:
        raise SystemExit("Synthetic owner requires a credential-free task; refusing a supplier-configured account")
    with transaction() as db:
        marker = db.get(Preference,MARKER)
        if marker is None:
            if args.action != "seed":
                raise SystemExit("Missing owned composite fixture")
            if db.get(AdvancedWorkspace,WORKSPACE):
                raise SystemExit("Composite workspace exists without ownership")
            value = seed(db)
        else:
            value = dict(marker.value)
        if value.get("task") != TASK or value.get("synthetic") is not True:
            raise SystemExit("Incompatible composite fixture ownership")
        if args.action == "activate" and not value.get("composite"):
            composite = first_use(db,value["history"],value["mapping"])
            revision = db.get(CompositeRevision,composite.active_revision_id)
            target = DatasetIdentity.model_validate(db.get(MarketDataset,value["target"]).identity)
            from alerts.realtime_switch import set_enabled
            history_id = db.get(HistoryVersion,revision.history_version_id).dataset_id
            set_enabled(db,db.get(MarketDataset,history_id).instrument_id,True,now=now_ms())
            prep = db.get(CompositePreparation,revision.id)
            end = prep.cutoff
            apply_minutes(db,record(db,CandleBatch(identity=target,window_start=revision.seam,
                window_end=end,checkpoint=end,observed_at=now_ms(),result={"status":"data"},
                rows=tuple(minute(at) for at in range(revision.seam,end,WIDTH)),
                volume_kind="price_count",volume_unit="quotes")),revision_id=revision.id)
            prep.status,prep.cursor = "queried",end
            value.update(composite=composite.id,revision=revision.id,seam=revision.seam)
            marker.value = value
            db.add(AdvancedWorkspace(id=WORKSPACE,name="统一 SSE · 合成组合",
                document={"engine":"tv31","schemaVersion":1,"symbol":encode(composite.id,"composite"),
                          "series_kind":"composite","interval":"1"}))
        if value.get("composite"):
            workspace = db.get(AdvancedWorkspace,WORKSPACE)
            if workspace is not None:
                workspace.updated_at = now_ms()
                if args.action == "seed":
                    workspace.document = {"engine":"tv31","schemaVersion":1,
                        "symbol":encode(value["composite"],"composite"),"series_kind":"composite","interval":"1"}
                    workspace.revision += 1
        if args.action == "expire":
            owner = db.get(PricingOwner,live_pricing.account_key(settings.oanda_account_id))
            if owner and owner.token == value.get("owner_token"):
                owner.expires = 0
        artifacts_ready = all(status == "published" for status in db.scalars(select(HistoryArtifact.status).where(
            HistoryArtifact.version_id == value["version"])))
        version = db.get(HistoryVersion,value["version"])
        history_bounds = {"start":version.start,"end":version.end}
        expected = {}
        if args.action == "state" and value.get("composite"):
            from alerts.chart_api import DataQuery
            from alerts.series_access import chart_data

            for frame in ("M1","D1","W1","MN"):
                page = chart_data(db,DataQuery(instrument=value["composite"],series_kind="composite",
                    timeframe=frame,limit=2000,provisional=True))
                expected[frame] = page["bars"][-1]
    if args.action == "quote":
        if not args.bid.is_finite() or not Decimal("0") < args.bid < Decimal("2"):
            raise SystemExit("Invalid synthetic bid")
        with transaction() as db:
            marker = db.get(Preference,MARKER)
            value = dict(marker.value)
            target = DatasetIdentity.model_validate(db.get(MarketDataset,value["target"]).identity)
            owner = db.get(PricingOwner,live_pricing.account_key(settings.oanda_account_id))
            ownership = (owner.id,owner.token) if owner and owner.token == value.get("owner_token") and owner.expires > now_ms() else None
            state = db.get(LiveState,target.key)
            forming = state.forming or {}
            confirmed_start = value.get("confirmed_cursor",value["seam"])
            confirmed_end = (now_ms()-5000) // WIDTH * WIDTH
            if confirmed_start < confirmed_end:
                # Synthetic source confirmation on a minute boundary, through
                # the same immutable writer used by actual REST confirmations.
                existing = set(db.scalars(select(CompositeMinute.start).where(
                    CompositeMinute.revision_id == value["revision"],
                    CompositeMinute.start >= confirmed_start,CompositeMinute.start < confirmed_end)))
                confirmed = tuple(MinuteRow(timestamp=at,complete=True,volume=None,
                    **{field:forming[field] for field in ("open","high","low","close")})
                    if forming.get("start") == at else minute(at)
                    for at in range(confirmed_start,confirmed_end,WIDTH) if at not in existing)
                if confirmed:
                    apply_minutes(db,record(db,CandleBatch(identity=target,
                    window_start=confirmed_start,window_end=confirmed_end,checkpoint=confirmed_end,
                    observed_at=now_ms(),result={"status":"data"},
                    rows=confirmed,
                    volume_kind="price_count",volume_unit="quotes")),revision_id=value["revision"])
                value["confirmed_cursor"] = confirmed_end
        if ownership is None:
            ownership = live_pricing.claim(settings.oanda_account_id)
            if ownership is None:
                raise SystemExit("Another pricing owner is active; refusing takeover")
            epoch = live_pricing.begin_connection(ownership,{target.provider_symbol:target})
            value.update(owner_token=ownership[1],epoch=epoch,sequence=0)
            with transaction() as db:
                db.get(Instrument,db.get(MarketDataset,target.key).instrument_id).enabled = False
        value["sequence"] += 1
        at = now_ms()
        live_pricing.publish_event(ownership,value["epoch"],QuoteEvent(identity=target,bid=str(args.bid),
            ask="2",source_time=at,received_at=at,tradeable=True,connection_epoch=value["epoch"],
            sequence=value["sequence"]),{target.provider_symbol:target})
        with transaction() as db:
            db.get(Preference,MARKER).value = value
    print(json.dumps({"action":args.action,"synthetic":True,"workspace":WORKSPACE,
        "composite":value.get("composite"),"revision":value.get("revision"),
        "version":value["version"],"bid":str(args.bid),"committed_at":now_ms(),
        "history_bounds":history_bounds,
        "artifacts_ready":artifacts_ready,"expected":expected}))


if __name__ == "__main__":
    main()
