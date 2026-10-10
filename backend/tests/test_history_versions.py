from datetime import UTC, datetime
from decimal import Decimal

import pytest
from alerts import history_versions as history
from alerts.market_contracts import RequestResult
from alerts.storage import Bar, HistoryChunk, HistoryVersion, MarketCoverage
from sqlalchemy import select
from test_market_contracts import batch, minute
from test_market_datasets import register


class Adapter:
    def __init__(self, pages):
        self.pages = iter(pages)
        self.calls = []

    def page(self, identity, start, end):
        self.calls.append((start, end))
        return next(self.pages)


def create(database, end=120000):
    with database.begin() as db:
        inst = register(db)
        from alerts.market_contracts import DatasetIdentity

        return history.create_version(db, DatasetIdentity.model_validate(batch().identity).key, 0, end), inst.id


def test_import_restarts_at_committed_page_and_publishes_original_chunks(database):
    ident, instrument = create(database, end=180000)
    adapter = Adapter([
        batch(window_end=180000, rows=(minute(),), checkpoint=60000),
        batch(window_start=60000, window_end=180000, rows=(),
              result=RequestResult(status="timeout"), checkpoint=60000),
        batch(window_start=60000, window_end=180000,
              rows=(minute(60000), minute(120000)), observed_at=185000, checkpoint=180000),
    ])
    assert history.import_page(adapter, version_id=ident)
    assert history.import_page(adapter, version_id=ident)
    with database.begin() as db:
        version = db.get(HistoryVersion, ident)
        assert version.cursor == 60000 and version.status == "retrying"
        version.next_at = 0
    assert history.import_page(adapter, version_id=ident)
    assert adapter.calls == [(0, 180000), (60000, 180000), (60000, 180000)]
    with database.begin() as db:
        report = history.version_report(db, ident)
        assert report["status"] == "published"
        assert report["manifest"]["rows"] == 3 and report["manifest"]["unknown_minutes"] == 0
        assert len(report["manifest"]["chunks"]) == 2
        assert [row["timestamp"] for row in history.snapshot_rows(db, ident)] == [0, 60000, 120000]
        assert len(db.scalars(select(Bar).where(Bar.instrument_id == instrument, Bar.timeframe == "M1")).all()) == 3
    assert not history.import_page(adapter, version_id=ident)


def test_empty_success_records_unknown_and_no_price_coverage(database):
    ident, _ = create(database)
    adapter = Adapter([batch(rows=(), result=RequestResult(status="empty_success"), checkpoint=120000)])
    history.import_page(adapter, version_id=ident)
    with database.begin() as db:
        assert history.version_report(db, ident)["manifest"]["unknown_minutes"] == 2
        assert list(history.snapshot_rows(db, ident)) == []
        assert db.scalar(select(MarketCoverage)) is None


def test_revised_import_does_not_mutate_old_published_inputs(database):
    first, instrument = create(database)
    history.import_page(Adapter([batch(checkpoint=120000)]), version_id=first)
    with database.begin() as db:
        original = list(history.snapshot_rows(db, first))
        checksum = history.version_report(db, first)["manifest"]["checksum"]
    second, _ = create(database)
    revised = batch(rows=(minute(close="1.10"), minute(60000, close="1.10")),
                    observed_at=185000, checkpoint=120000)
    history.import_page(Adapter([revised]), version_id=second)
    with database.begin() as db:
        assert list(history.snapshot_rows(db, first)) == original
        assert history.version_report(db, first)["manifest"]["checksum"] == checksum
        assert history.version_report(db, second)["manifest"]["checksum"] != checksum
        assert db.scalar(select(Bar).where(Bar.instrument_id == instrument, Bar.timeframe == "M1",
                                         Bar.start == 0)).revision == 2
    with pytest.raises(ValueError, match="immutable"):
        with database.begin() as db:
            db.get(HistoryVersion, first).manifest = {}
    with pytest.raises(ValueError, match="immutable"):
        with database.begin() as db:
            db.scalar(select(HistoryChunk).where(HistoryChunk.version_id == first)).content = b"changed"


def test_expired_import_owner_cannot_publish_after_replacement(database):
    ident, _ = create(database)

    class Expired:
        def page(self, identity, start, end):
            with database.begin() as db:
                version = db.get(HistoryVersion, ident)
                version.lease_token = "replacement"
            return batch(checkpoint=120000)

    assert history.import_page(Expired(), version_id=ident)
    with database.begin() as db:
        assert db.get(HistoryVersion, ident).cursor == 0
        assert db.scalar(select(HistoryChunk)) is None
        assert db.scalar(select(Bar)) is None


def test_month_windows_and_fixed_past_cutoff():
    at = int(datetime(2024, 2, 10, tzinfo=UTC).timestamp() * 1000)
    assert history.month_end(at) == int(datetime(2024, 3, 1, tzinfo=UTC).timestamp() * 1000)


def test_excess_price_precision_is_rounded_and_published(database):
    ident, instrument = create(database)
    history.import_page(Adapter([batch(rows=(minute(close="1.111111"),),
        checkpoint=120000)]), version_id=ident)
    with database.begin() as db:
        version = db.get(HistoryVersion, ident)
        assert version.status == "published"
        assert version.manifest["price_precision"] == 5
        assert version.manifest["price_rule_version"]
        assert list(history.snapshot_rows(db, ident))[0]["close"] == "1.11111"
        assert db.scalar(select(Bar).where(Bar.instrument_id == instrument)).close == Decimal("1.11111")


def test_legacy_version_without_price_rule_keeps_raw_history_behavior(database):
    ident, instrument = create(database)
    with database.begin() as db:
        db.get(HistoryVersion, ident).manifest = {}
    history.import_page(Adapter([batch(rows=(minute(close="1.111111"),), checkpoint=120000)]),
                        version_id=ident)
    with database.begin() as db:
        version = db.get(HistoryVersion, ident)
        assert version.status == "published"
        assert "price_rule_version" not in version.manifest
        assert list(history.snapshot_rows(db, ident))[0]["close"] == "1.111111"
