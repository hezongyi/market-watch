"""Synthetic mapping R1 only; refuses every other database/project."""
import hashlib
import json
import os
from sqlalchemy import select
from sqlalchemy.engine import make_url
from alerts.config import settings
from alerts.storage import MarketCatalog, HistoryVersion, transaction
from alerts.market_contracts import DatasetIdentity, MinuteRow, CandleBatch, RequestResult
from alerts.market_datasets import register_dataset
from alerts.history_versions import create_version, import_page
from alerts.history_artifacts import artifact_tick
from alerts.history_catalog import account_scope
from alerts.history_maintenance import configure

url = make_url(settings.database_url)
task = os.environ.get("MW_MAPPING_FIXTURE_TASK", "mw-composite-mapping-20261021")
assert task in {"mw-composite-mapping-20261021", "mw-integration-20261022"}
assert settings.database_application_name == task
assert url.host == "postgres" and url.database == "preview" and url.username == "preview"
assert not settings.delivery_enabled and not settings.yahoo_enabled and not settings.oanda_stream_enabled
assert settings.oanda_account_id == "mapping-synthetic-account"
START = 1791158400000
END = START + 3 * 86400000
result = []
for symbol, code, asset, precision in [
    ("EUR/USD", "EUR_USD", "forex", 5),
    ("USD/CAD", "USD_CAD", "forex", 5),
    ("XAU/USD", "XAU_USD", "metal", 3),
]:
    identity = DatasetIdentity(source="dukascopy", channel="python", environment="historical",
        account_scope="public", provider_symbol=symbol, basis="bid", calendar_version="mapping-r1-v1")
    catalog_id = "HC:" + hashlib.sha256(code.encode()).hexdigest()[:36]
    with transaction() as db:
        register_dataset(db, identity, logical_symbol=symbol.replace("/", ""), label="Synthetic " + symbol,
            calendar="ny17", precision=precision, volume_kind="quantity", volume_unit="source_quantity", asset_class=asset)
        if not db.get(MarketCatalog, catalog_id):
            db.add(MarketCatalog(id=catalog_id, source="oanda", symbol=code, label="Synthetic " + code,
                asset_type="METAL" if asset == "metal" else "CURRENCY", precision=precision, calendar="ny17",
                metadata_json={"history_account_scope": account_scope()}))
        version = db.scalar(select(HistoryVersion).where(HistoryVersion.dataset_id == identity.key))
        version_id = version.id if version else create_version(db, identity.key, START, END)
    class Supply:
        def page(self, requested, left, right):
            assert requested == identity
            price = "2600.000" if asset == "metal" else "1.10000"
            rows = tuple(MinuteRow(timestamp=at, open=price, high=price, low=price, close=price,
                volume="1", complete=True) for at in [left, left + 60000, right - 120000, right - 60000])
            return CandleBatch(identity=identity, window_start=left, window_end=right, observed_at=END+5000,
                rows=rows, result=RequestResult(status="data"), checkpoint=right,
                volume_kind="quantity", volume_unit="source_quantity")
    import_page(Supply(), version_id=version_id)
    while artifact_tick(version_id):
        pass
    with transaction() as db:
        configure(db, identity.key, target_start=START, timeframes=["M1"], frequency="once")
    result.append({"symbol": code.replace("_", ""), "id": identity.key, "catalog_id": catalog_id, "version_id": version_id})
print(json.dumps(result))
