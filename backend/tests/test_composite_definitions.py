"""Saved mapping, pure management, immutable first use and fixed publication."""

import pytest
from alerts.chart_data import FRAMES
from alerts.composite_definitions import ProductMatch, first_use, save_mapping
from alerts.config import settings
from alerts.history_artifacts import artifact_tick
from alerts.history_catalog import account_scope
from alerts.history_retention import references
from alerts.history_versions import create_version, import_page
from alerts.storage import (
    CompositePreparation,
    CompositeRevision,
    HistoryArtifact,
    Instrument,
    MarketCatalog,
    MarketComposite,
    MarketDataset,
    MarketDemand,
    RealtimeMapping,
)
from sqlalchemy import delete, func, select
from test_history_versions import Adapter
from test_market_contracts import batch, identity, minute
from test_market_datasets import register

PROOF = {"underlying": "EUR", "quote_currency": "USD", "historical_product": "spot_fx",
    "live_product": "spot_fx", "relationship": "same_product",
    "historical_evidence": "https://www.dukascopy.com/swiss/english/marketwatch/historical/",
    "live_evidence": "https://developer.oanda.com/rest-live-v20/pricing-ep/",
    "rationale": "Explicitly reviewed EUR versus USD Bid prices in the two products", "reviewed": True}


def prepare(database, monkeypatch):
    # These fixture candles use an explicit 1970 business clock. Live-tail
    # availability must use that same clock rather than the host wall clock.
    monkeypatch.setattr("alerts.live_window.now_ms", lambda: 200010000)
    monkeypatch.setattr("alerts.composite_preparation.now_ms", lambda: 200010000)
    monkeypatch.setattr("alerts.composite_revisions.now_ms", lambda: 200010000)
    monkeypatch.setattr("alerts.baseline_shadow.now_ms", lambda: 200010000)
    monkeypatch.setattr("alerts.composite_series.now_ms", lambda: 200010000)
    monkeypatch.setattr("alerts.composite_chart.now_ms", lambda: 200010000)
    monkeypatch.setattr("alerts.chart_alert_geometry.now_ms", lambda: 200010000)
    monkeypatch.setattr("alerts.series_access.now_ms", lambda: 200010000)
    monkeypatch.setattr(settings, "oanda_account_id", "composite-test-account")
    monkeypatch.setattr(settings, "oanda_token", "test-token")
    catalog_id = "HC:" + "a" * 36
    with database.begin() as db:
        register(db)
        db.add(MarketCatalog(id=catalog_id, source="oanda", symbol="EUR_USD", label="Euro",
            asset_type="CURRENCY", precision=5, calendar="ny17",
            metadata_json={"history_account_scope": account_scope()}))
    return catalog_id


def publish(database, end=172920000):
    with database.begin() as db:
        ident = create_version(db, identity().key, 0, end)
    import_page(Adapter([batch(window_end=end, checkpoint=end, rows=(minute(), minute(60000),
        minute(end - 120000), minute(end - 60000)))]), version_id=ident)
    while artifact_tick(ident):
        pass
    return ident


def test_saved_mapping_has_explicit_proof_and_creates_no_demand(database, monkeypatch):
    catalog_id = prepare(database, monkeypatch)
    with database.begin() as db:
        mapping = save_mapping(db, identity().key, catalog_id, PROOF)
        assert save_mapping(db, identity().key, catalog_id, PROOF).id == mapping.id
        assert mapping.match["basis"] == "bid"
        assert db.scalar(select(MarketDemand)) is None
        assert db.scalar(select(MarketComposite)) is None
        target = db.get(MarketDataset, mapping.target_dataset_id)
        assert not db.get(Instrument, target.instrument_id).enabled
        with pytest.raises(ValueError, match="准确代码"):
            save_mapping(db, identity().key, catalog_id, {**PROOF, "underlying": "GBP"})
        with pytest.raises(ValueError, match="产品类型"):
            save_mapping(db, identity().key, catalog_id, {**PROOF,
                "historical_product": "spot_metal", "live_product": "spot_metal"})
    with pytest.raises(ValueError, match="immutable"):
        with database.begin() as db:
            db.get(RealtimeMapping, mapping.id).match = {"reviewed": False}
    monkeypatch.setattr(settings, "oanda_account_id", "different-account")
    with database.begin() as db:
        with pytest.raises(ValueError, match="当前OANDA"):
            save_mapping(db, identity().key, catalog_id, PROOF)


def test_product_types_must_not_be_silently_equated():
    with pytest.raises(ValueError, match="产品类型"):
        ProductMatch.model_validate({**PROOF, "live_product": "cfd"})
    proof = ProductMatch.model_validate({**PROOF, "live_product": "cfd",
                                       "relationship": "same_underlying_different_product"})
    assert proof.live_product == "cfd"


def test_first_use_fixes_baseline_and_seam_and_daily_publish_does_not_replace_it(database, monkeypatch):
    catalog_id = prepare(database, monkeypatch)
    parent = publish(database)
    with database.begin() as db:
        mapping = save_mapping(db, identity().key, catalog_id, PROOF)
        composite = first_use(db, identity().key, mapping.id)
        original = db.get(CompositeRevision, composite.active_revision_id)
        assert original.history_version_id == parent and original.seam == 165600000
        assert db.get(CompositePreparation, original.id).cursor == original.seam
        assert first_use(db, identity().key, mapping.id).id == composite.id
        # A pre-upgrade composite may only have requested M1. Reopening must
        # backfill period tasks on its fixed parent without adopting daily head.
        db.execute(delete(HistoryArtifact).where(HistoryArtifact.version_id == parent,
            HistoryArtifact.timeframe != "M1", HistoryArtifact.status == "pending"))
        assert db.scalar(select(func.count()).select_from(MarketComposite)) == 1
        assert db.scalar(select(MarketDemand)) is None
        assert references(db, identity().key)["items"]
        with pytest.raises(ValueError, match="权限范围"):
            first_use(db, identity().key, mapping.id, permission_scope="another-workspace")
    publish(database, end=259320000)
    with database.begin() as db:
        repeated = first_use(db, identity().key, mapping.id)
        assert repeated.active_revision_id == original.id
        assert db.get(CompositeRevision, original.id).history_version_id == parent
        assert db.get(CompositeRevision, original.id).seam == 165600000
        assert set(db.scalars(select(HistoryArtifact.timeframe).where(
            HistoryArtifact.version_id == parent))) == set(FRAMES)
    with pytest.raises(ValueError, match="immutable"):
        with database.begin() as db:
            db.get(CompositeRevision, original.id).seam += 60000
    monkeypatch.setattr(settings, "oanda_account_id", "another-account")
    with database.begin() as db:
        with pytest.raises(ValueError, match="其他账户"):
            first_use(db, identity().key, mapping.id)


def test_first_use_requires_fixed_published_m1_not_only_registered_source(database, monkeypatch):
    catalog_id = prepare(database, monkeypatch)
    with database.begin() as db:
        mapping = save_mapping(db, identity().key, catalog_id, PROOF)
        with pytest.raises(ValueError, match="可用的固定M1"):
            first_use(db, identity().key, mapping.id)
        assert db.scalar(select(MarketComposite)) is None
