from decimal import Decimal

import pytest
from alerts.history_derivation import derive_page, derive_version
from alerts.history_versions import import_page, snapshot_rows
from alerts.market_datasets import register_dataset
from alerts.storage import Bar, HistoryChunk, HistoryVersion, MarketCoverage
from sqlalchemy import select
from test_history_versions import Adapter, create
from test_market_contracts import batch, minute
from test_market_datasets import identity


def destination(db, **changes):
    ident = identity(calendar_version="observed-v2", **changes)
    inst = register_dataset(db, ident, logical_symbol="EURUSD", label="FX", calendar="ny17",
        precision=6, volume_kind="quantity", volume_unit="source_quantity")
    return ident.key, inst.id


def test_derived_version_reuses_original_chunks_even_if_staging_is_newer(database):
    parent, old_inst = create(database)
    import_page(Adapter([batch(checkpoint=120000)]), version_id=parent)
    newer, _ = create(database)
    import_page(Adapter([batch(rows=(minute(close="1.11555"), minute(60000, close="1.11555")),
                               checkpoint=120000)]), version_id=newer)
    with database.begin() as db:
        target, new_inst = destination(db)
        derived = derive_version(db, parent, target)
        original = db.get(HistoryVersion, parent).manifest.copy()
    assert derive_page(derived)
    # Simulated process boundary: a new call resumes after committed first page.
    assert derive_page(derived)
    assert not derive_page(derived)
    with database.begin() as db:
        version = db.get(HistoryVersion, derived)
        assert version.status == "published"
        assert list(snapshot_rows(db, derived)) == list(snapshot_rows(db, parent))
        assert version.manifest["provenance"]["copied_minutes"] == 2
        assert version.manifest["provenance"]["derived_from_version"] == parent
        assert db.get(HistoryVersion, parent).manifest == original
        old = db.scalar(select(Bar).where(Bar.instrument_id == old_inst, Bar.timeframe == "M1", Bar.start == 0))
        copied = db.scalar(select(Bar).where(Bar.instrument_id == new_inst, Bar.timeframe == "M1", Bar.start == 0))
        assert old.close != copied.close
        assert copied.close == Decimal(list(snapshot_rows(db, parent))[0]["close"])
        coverage = db.scalar(select(MarketCoverage).where(MarketCoverage.instrument_id == new_inst))
        assert (coverage.start, coverage.end, coverage.observed) == (0, 120000, 2)


def test_partial_parent_is_quarantined_and_derived_task_continues_at_same_checkpoint(database):
    parent, _ = create(database, end=180000)
    import_page(Adapter([batch(window_end=180000, rows=(minute(),), checkpoint=60000)]), version_id=parent)
    with database.begin() as db:
        target, _ = destination(db)
        with pytest.raises(ValueError, match="quarantine"):
            derive_version(db, parent, target)
        derived = derive_version(db, parent, target, quarantine_reason="price_precision_evidence")
    assert derive_page(derived)
    assert derive_page(derived)
    with database.begin() as db:
        assert db.get(HistoryVersion, parent).cursor == 60000
        assert db.get(HistoryVersion, parent).status == "configuration_error"
        assert db.get(HistoryVersion, derived).status == "pending"
        assert db.get(HistoryVersion, derived).cursor == 60000
    revised = batch(identity=identity(calendar_version="observed-v2"), window_start=60000,
        window_end=180000, rows=(minute(60000, close="1.111111"), minute(120000)),
        checkpoint=180000, observed_at=185000)
    import_page(Adapter([revised]), version_id=derived)
    with database.begin() as db:
        assert db.get(HistoryVersion, derived).status == "published"
        assert db.get(HistoryVersion, derived).manifest["provenance"]["copied_chunks"] == 1
        assert db.scalar(select(HistoryChunk).where(HistoryChunk.version_id == parent)).count == 1


def test_derivation_cannot_copy_another_series_or_discard_active_lease(database):
    parent, _ = create(database)
    with database.begin() as db:
        target, _ = destination(db, channel="node")
        with pytest.raises(ValueError, match="replace"):
            derive_version(db, parent, target, quarantine_reason="fixture")
    with database.begin() as db:
        target, _ = destination(db)
        db.get(HistoryVersion, parent).lease_token = "active-writer"
        with pytest.raises(ValueError, match="lease"):
            derive_version(db, parent, target, quarantine_reason="fixture")
