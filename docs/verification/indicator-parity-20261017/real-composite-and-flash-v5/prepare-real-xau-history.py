"""Task-isolated real Dukascopy import; no fabricated rows or closure claims."""
import json
import time
from datetime import UTC, datetime
from sqlalchemy import select
from alerts.config import settings
from alerts.dukascopy_history import DukascopyHistory
from alerts.history_maintenance import configure, create_run
from alerts.history_versions import import_page
from alerts.history_artifacts import artifact_tick
from alerts.market_contracts import DatasetIdentity
from alerts.market_datasets import register_dataset
from alerts.storage import transaction, HistoryVersion, HistoryArtifact

START = int(datetime(2026, 8, 17, tzinfo=UTC).timestamp()*1000)
END = int(datetime(2026, 10, 17, tzinfo=UTC).timestamp()*1000)
identity = DatasetIdentity(source="dukascopy", channel="python", environment="historical",
    account_scope="public", provider_symbol="XAU/USD", basis="bid",
    calendar_version="issue74-real-xau-ny17-phase-v1")
assert not settings.delivery_enabled
adapter = DukascopyHistory(proxy=settings.market_proxy)
class Source:
    def page(self, raw, start, end):
        return adapter.page(DatasetIdentity.model_validate(raw),start,end)

try:
    probe=adapter.page(identity,START,START+86400000)
    assert probe.result.successful and probe.rows, probe.result.status
    print(json.dumps({"stage":"source_verified","source":"Dukascopy XAU/USD BID M1",
        "rows":len(probe.rows),"first":probe.rows[0].model_dump(),
        "last":probe.rows[-1].model_dump()}),flush=True)
    with transaction() as db:
        dataset=register_dataset(db,identity,logical_symbol="XAUUSD",
            label="Issue74 真实 XAUUSD 近两个月",calendar="ny17",precision=3,
            volume_kind="quantity",volume_unit="source_quantity",asset_class="metal")
        configure(db,identity.key,target_start=START,
            timeframes=["M1","M5","M15","M30","H1","H4","D1","W1","MN"],
            frequency="daily",daily_minute=30,overlap_minutes=2880)
        version_id=create_run(db,identity.key,end=END,request_id="issue74-real-xau-20260817-20261017").id
        print(json.dumps({"stage":"created","dataset_id":identity.key,"version_id":version_id,
            "start":START,"end_exclusive":END,"calendar":"NY17 aggregation phase only; gaps remain unknown"}),flush=True)
    for _ in range(200):
        with transaction() as db:
            v=db.get(HistoryVersion,version_id)
            print(json.dumps({"stage":"import","status":v.status,"cursor":v.cursor,"end":v.end,
                "rows":v.manifest.get("rows"),"error":v.error}),flush=True)
            if v.status=="published":break
            assert v.status not in ("failed","cancelled","paused"),v.status
            if v.status=="retrying":raise RuntimeError("Supplier/import retry required; preserve checkpoint")
        import_page(Source(),version_id=version_id)
    else:raise RuntimeError("Bounded import iteration limit")
    for _ in range(400):
        if not artifact_tick(version_id):break
    with transaction() as db:
        v=db.get(HistoryVersion,version_id)
        artifacts=[{"frame":a.timeframe,"status":a.status,"rows":a.count} for a in
            db.scalars(select(HistoryArtifact).where(HistoryArtifact.version_id==version_id))]
        assert all(a["status"]=="published" for a in artifacts) and len(artifacts)==9
        report={"stage":"ready","dataset_id":identity.key,"version_id":version_id,
            "manifest":v.manifest,"artifacts":artifacts,"composite_ready":False}
        open("/tmp/issue74-real-xau-history-report.json","w").write(json.dumps(report,indent=2))
        print(json.dumps({k:v for k,v in report.items() if k!="manifest"}),flush=True)
finally:adapter.close()
