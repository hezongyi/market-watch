"""Exclusive indexed chart pagination with frozen inputs and seam aggregation."""

from alerts.composite_chart import chart_page
from alerts.composite_inputs import apply_minutes
from alerts.composite_series import period, read_window
from alerts.confirmed_minutes import record
from alerts.history_artifacts import artifact_tick
from alerts.market_contracts import DatasetIdentity
from alerts.storage import CompositeRevision, MarketDataset, RealtimeMapping
from test_composite_preparation import ready
from test_market_contracts import batch, minute


def populated(database, monkeypatch):
    revision_id = ready(database, monkeypatch)
    with database.begin() as db:
        revision = db.get(CompositeRevision, revision_id)
        target = db.get(MarketDataset, db.get(RealtimeMapping, revision.mapping_id).target_dataset_id)
        ident = DatasetIdentity.model_validate(target.identity)
        seam = revision.seam
        source = batch(identity=ident, window_start=seam, window_end=seam + 600000,
            checkpoint=seam + 600000, observed_at=200000000, volume_kind="price_count", volume_unit="quotes",
            rows=tuple(minute(at, volume="3") for at in range(seam, seam + 600000, 60000)))
        apply_minutes(db, record(db, source))
        composite = revision.composite_id
        parent = revision.history_version_id
    while artifact_tick(parent):
        pass
    return composite, revision_id, seam


def test_latest_first_exclusive_pages_return_ascending_fixed_input_without_m1_rescan(database, monkeypatch):
    composite, revision, seam = populated(database, monkeypatch)
    with database.begin() as db:
        seen, before = [], None
        for _ in range(8):
            page = chart_page(db, composite, "M1", before=before, count=3, now=200010000)
            starts = [row["start"] for row in page["bars"]]
            assert starts == sorted(starts)
            assert page["revision_id"] == revision and page["input_revision"] == 1
            seen += starts
            before = page["next_before"]
            if before is None:
                break
        assert len(seen) == len(set(seen)) == 12
        assert min(seen) == 0 and max(seen) == seam + 540000
    def forbidden(*args, **kwargs):
        raise AssertionError("Old history pages reuse indexed period artifacts")
    monkeypatch.setattr("alerts.composite_series.snapshot_rows", forbidden)
    with database.begin() as db:
        page = chart_page(db, composite, "M1", before=seam, count=3, now=200010000)
        assert [row["start"] for row in page["bars"]] == [0, 60000]
        assert page["bounded_partitions"] == 0


def test_week_seam_is_aggregated_from_stitched_m1_not_concatenated_daily_bars(database, monkeypatch):
    composite, revision, seam = populated(database, monkeypatch)
    with database.begin() as db:
        page = chart_page(db, composite, "W1", count=3, now=200010000)
        from alerts.composite_series import period
        left, right = period(seam, "W1", "ny17")
        fixed = read_window(db, composite, "W1", left, right, now=200010000)
        assert page["bars"] == fixed["bars"]
        assert page["bars"][0]["seam_crossing"] and page["bars"][0]["mixed_source"]
        assert page["bars"][0]["volume"] is None


def test_older_input_page_does_not_include_newer_confirmations(database, monkeypatch):
    composite, revision_id, seam = populated(database, monkeypatch)
    with database.begin() as db:
        revision = db.get(CompositeRevision, revision_id)
        target = db.get(MarketDataset, db.get(RealtimeMapping, revision.mapping_id).target_dataset_id)
        apply_minutes(db, record(db, batch(identity=DatasetIdentity.model_validate(target.identity),
            window_start=seam, window_end=seam + 660000, checkpoint=seam + 660000, observed_at=200001000,
            volume_kind="price_count", volume_unit="quotes", rows=(minute(seam + 600000, volume="3"),))))
        old = chart_page(db, composite, "M1", count=1, input_revision=1, now=200010000)
        new = chart_page(db, composite, "M1", count=1, now=200010000)
        assert old["bars"][-1]["start"] == seam + 540000
        assert new["bars"][-1]["start"] == seam + 600000


def test_sparse_tail_preserves_history_only_seam_bucket_and_exclusive_cursor(database, monkeypatch):
    revision_id = ready(database, monkeypatch)
    with database.begin() as db:
        revision = db.get(CompositeRevision, revision_id)
        target = db.get(MarketDataset, db.get(RealtimeMapping, revision.mapping_id).target_dataset_id)
        late = revision.seam + 70 * 86400000
        apply_minutes(db, record(db, batch(identity=DatasetIdentity.model_validate(target.identity),
            window_start=late, window_end=late + 60000, checkpoint=late + 60000,
            observed_at=late + 100000, volume_kind="price_count", volume_unit="quotes",
            rows=(minute(late, volume="3"),))))
        page = chart_page(db, revision.composite_id, "W1", count=3, now=late + 100000)
        seam_start = period(revision.seam, "W1", "ny17")[0]
        assert [row["start"] for row in page["bars"]] == [seam_start, period(late, "W1", "ny17")[0]]
        assert page["bars"][0]["observed_minutes"] == 2
        assert not page["bars"][0]["coverage_complete"]
        older = chart_page(db, revision.composite_id, "W1", before=page["bars"][-1]["start"],
            count=3, now=late + 100000)
        assert [row["start"] for row in older["bars"]] == [seam_start]


def test_sparse_months_page_with_bounded_partitions_and_no_duplicate_buckets(database, monkeypatch):
    composite, revision_id, seam = populated(database, monkeypatch)
    with database.begin() as db:
        revision = db.get(CompositeRevision, revision_id)
        target = db.get(MarketDataset, db.get(RealtimeMapping, revision.mapping_id).target_dataset_id)
        times = [seam + offset * 40 * 86400000 for offset in range(1, 8)]
        for at in times:
            apply_minutes(db, record(db, batch(identity=DatasetIdentity.model_validate(target.identity),
                window_start=at, window_end=at + 60000, checkpoint=at + 60000,
                observed_at=at + 100000, volume_kind="price_count", volume_unit="quotes",
                rows=(minute(at, volume="3"),))))
        seen, cursor = [], None
        for _ in range(6):
            page = chart_page(db, composite, "MN", before=cursor, count=2, now=times[-1] + 100000)
            assert page["bounded_partitions"] <= 4
            assert page["input_revision"] == 8
            starts = [row["start"] for row in page["bars"]]
            assert starts == sorted(starts) and (cursor is None or all(at < cursor for at in starts))
            seen += starts
            cursor = page["next_before"]
            if cursor is None:
                break
        expected = {period(at, "MN", "ny17")[0] for at in [0, seam, *times]}
        assert len(seen) == len(set(seen)) and set(seen) == expected and cursor is None


def test_pending_artifact_is_disclosed_without_mutating_or_switching_baseline(database, monkeypatch):
    revision_id = ready(database, monkeypatch)
    with database.begin() as db:
        revision = db.get(CompositeRevision, revision_id)
        page = chart_page(db, revision.composite_id, "H4", before=revision.seam, now=200010000)
        assert page["history_version_id"] == revision.history_version_id
        assert page["bars"] == [] and page["pending"] and page["has_more"]
        assert page["bounded_partitions"] == 0 and page["input_revision"] == 0
