"""Deterministic fixtures in the dedicated Ubuntu acceptance PostgreSQL only.

Uses the real register/maintenance/import/artifact/reclaim contracts. The adapter
returns synthetic bounded candles and never contacts a supplier.
"""
import hashlib
import json
import sys

from sqlalchemy import select, text

from alerts.config import settings
from alerts.data_center import dataset_detail, task_feed
from alerts.history_artifacts import artifact_tick
from alerts.history_maintenance import configure, create_run
from alerts.history_retention import ReclamationConflict, reclaim, references
from alerts.history_versions import import_page, snapshot_rows
from alerts.market_contracts import CandleBatch, DatasetIdentity, MinuteRow, RequestResult
from alerts.market_datasets import register_dataset
from alerts.storage import ChartWorkspace, DatasetMaintenance, HistoryRun, HistoryVersion, MarketDataset, MarketDemand, transaction

START = 1791320400000  # 2026-10-06 21:00 UTC, NY17 trading date 2026-10-07.


class FixtureAdapter:
    def page(self, raw, start, end):
        identity = DatasetIdentity.model_validate(raw)
        return CandleBatch(identity=identity, window_start=start, window_end=end,
            observed_at=end + 5000, checkpoint=end, result=RequestResult(status="data"),
            rows=tuple(MinuteRow(timestamp=at, open="1.10", high="1.12", low="1.09",
                close="1.11", volume="6", complete=True) for at in range(start, end, 60000)),
            volume_kind="price_count" if identity.source == "oanda" else "quantity",
            volume_unit="quotes" if identity.source == "oanda" else "source_quantity")


def publish(dataset, request, end):
    with transaction() as db:
        version = create_run(db, dataset, end=end, request_id=request).id
    for _ in range(10):
        with transaction() as db:
            if db.get(HistoryVersion, version).status == "published":
                break
        assert import_page(FixtureAdapter(), version_id=version)
    while artifact_tick(version):
        pass
    with transaction() as db:
        assert db.get(HistoryRun, version).completed_at is not None
    return version


def main():
    assert settings.database_application_name == "mw-dataset-management-20261010"
    assert settings.database_url.split("@")[-1] == "pg/dataset_management"
    assert not settings.delivery_enabled and not settings.oanda_stream_enabled
    if sys.argv[1:] == ["--inspect"]:
        return inspect_fixtures()
    if sys.argv[1:] == ["--fingerprint"]:
        return fingerprint()
    if sys.argv[1:] == ["--verify-protection"]:
        return verify_protection()
    with transaction() as db:
        assert not db.scalar(select(MarketDataset)), "Preserve existing acceptance state; seed only an empty task database"
    datasets = []
    for source, calendar, code in [("dukascopy", "ny17", "EURUSD"), ("dukascopy", "utc0", "EURUSD"),
                                   ("oanda", "ny17", "EURUSD"), ("dukascopy", "ny17", "XAUUSD")]:
        identity = DatasetIdentity(source=source, channel="v20" if source == "oanda" else "python",
            environment="practice" if source == "oanda" else "historical",
            account_scope="sha256:" + hashlib.sha256(settings.oanda_account_id.encode()).hexdigest() if source == "oanda" else "public",
            provider_symbol="EUR_USD" if source == "oanda" else "XAU/USD" if code == "XAUUSD" else "EUR/USD",
            basis="bid", calendar_version=f"dataset-management-{calendar}-{source}-v1")
        with transaction() as db:
            register_dataset(db, identity, logical_symbol=code, label="管理UI隔离验收", calendar=calendar,
                precision=5, volume_kind="price_count" if source == "oanda" else "quantity",
                volume_unit="quotes" if source == "oanda" else "source_quantity", asset_class="metal" if code == "XAUUSD" else "forex")
            configure(db, identity.key, target_start=START, timeframes=["M1","M5","M15","M30","H1","H4","D1","W1","MN"],frequency="once",overlap_minutes=1)
            db.get(DatasetMaintenance, identity.key).paused = True
        versions = [publish(identity.key, "dataset-ui-initial", START + 3600000)]
        if not datasets:
            versions.append(publish(identity.key, "dataset-ui-update", START + 7200000))
        datasets.append({"id":identity.key,"source":source,"calendar":calendar,"code":code,"versions":versions})
    # A separate own fixture verifies retained manifests after real reclamation.
    with transaction() as db:
        plan = db.get(DatasetMaintenance, datasets[-1]["id"])
        plan.archived = True
        db.flush()
        removed = reclaim(db, datasets[-1]["id"], "dataset-ui-reclaim")
        assert removed["versions"] == 1
    inspect_fixtures()


def inspect_fixtures():
    assert settings.database_application_name == "mw-dataset-management-20261010"
    assert settings.database_url.split("@")[-1] == "pg/dataset_management"
    with transaction() as db:
        records=list(db.scalars(select(MarketDataset)))
        assert len(records)==4 and all(row.identity["calendar_version"].startswith("dataset-management-") for row in records)
        datasets=[]
        for row in records:
            detail=dataset_detail(db,row.id)
            versions=list(db.scalars(select(HistoryVersion.id).where(HistoryVersion.dataset_id==row.id, HistoryVersion.status == "published").order_by(HistoryVersion.created_at)))
            datasets.append({"id":row.id,"source":row.identity["source"],"calendar":detail["aggregation_calendar"],"code":row.logical_symbol,"display_symbol":detail["display_symbol"],"versions":versions})
        primary=next(d for d in datasets if d["code"]=="EURUSD" and d["source"]=="dukascopy" and d["calendar"]=="ny17")
        target=primary["id"]
        before=db.scalar(select(MarketDemand))
        feed=task_feed(db,dataset_id=target,query=primary["code"],source="dukascopy",status="all",page_size=100)
        assert len(feed["items"])>=2 and all(row["dataset_id"]==target for row in feed["items"])
        assert len(primary["versions"]) == 2
        assert task_feed(db,dataset_id=target,status="active")["items"]==[]
        ordinary = task_feed(db,query="EURUSD",status="all",page_size=100)["items"]
        assert len(ordinary)>=4 and len({row["dataset_id"] for row in ordinary})==3
        assert dataset_detail(db,target)["logical_symbol"]==primary["code"]
        assert db.scalar(select(MarketDemand)) is before is None
    print(json.dumps({"environment":"Ubuntu isolated PostgreSQL 14","passed":True,
        "same_code_distinct_source_and_calendar":True,"exact_dataset_tasks":len(feed["items"]),
        "ordinary_code_tasks":len(ordinary),"read_created_demand":False,"real_supplier_connections":False,
        "datasets":datasets},indent=2))


def fingerprint():
    """Hash stored business rows without exporting any credentials or prices."""
    with transaction() as db:
        # Chart workspace stream heartbeats run independently of this dialog.
        # Include stored historical/source/demand data, exclude those heartbeats.
        tables = db.scalars(text("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'market_%' AND tablename NOT LIKE 'market_stream_%' ORDER BY tablename"))
        result = {}
        for name in tables:
            assert name.replace('_', '').isalnum()
            rows = list(db.scalars(text(f'SELECT row_to_json(t)::text FROM "{name}" t ORDER BY row_to_json(t)::text')))
            result[name] = {"rows": len(rows), "sha256": hashlib.sha256('\n'.join(rows).encode()).hexdigest()}
    print(json.dumps(result, sort_keys=True))


def verify_protection():
    with transaction() as db:
        version = db.scalar(select(HistoryVersion).where(HistoryVersion.status == "published").order_by(HistoryVersion.created_at))
        assert version is not None
        before = list(snapshot_rows(db, version.id))
        assert before
        savepoint = db.begin_nested()
        try:
            plan = db.get(DatasetMaintenance, version.dataset_id)
            plan.paused = plan.archived = True
            workspace = ChartWorkspace(name="own rollback-only acceptance reference", document={"version_id": version.id})
            db.add(workspace)
            db.flush()
            report = references(db, version.dataset_id)
            assert any(item['kind'] == 'workspace' and item['id'] == workspace.id for item in report['items'])
            try:
                reclaim(db, version.dataset_id, "dataset-ui-protection-check", expected_review_revision=report['impact']['review_revision'])
                raise AssertionError("Backend must reject protected historical prices")
            except ReclamationConflict as error:
                assert '引用' in str(error)
            assert list(snapshot_rows(db, version.id)) == before
        finally:
            savepoint.rollback()
        assert list(snapshot_rows(db, version.id)) == before
    print(json.dumps({"environment": "Ubuntu isolated PostgreSQL 14", "passed": True,
        "actual_workspace_reference_blocks_backend_reclaim": True, "prices_unchanged": True,
        "temporary_reference_rolled_back": True}))


if __name__ == "__main__":
    main()
