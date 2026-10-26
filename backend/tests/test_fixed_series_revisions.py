"""Loaded-prefix corrections redraw charts; new tail input does not reset history."""

from alerts.chart_query import DataQuery, data_sync
from alerts.composite_inputs import apply_minutes
from alerts.confirmed_minutes import record
from alerts.market_contracts import DatasetIdentity
from alerts.storage import CompositeRevision, MarketDataset, RealtimeMapping
from test_composite_chart import populated
from test_market_contracts import batch, minute
from test_series_access import fixture


def correction(db, revision_id, at, observed, close="1.11"):
    revision = db.get(CompositeRevision, revision_id)
    target = db.get(MarketDataset, db.get(RealtimeMapping, revision.mapping_id).target_dataset_id)
    apply_minutes(db, record(db, batch(identity=DatasetIdentity.model_validate(target.identity),
        window_start=at, window_end=at + 60000, checkpoint=at + 60000, observed_at=observed,
        volume_kind="price_count", volume_unit="quotes", rows=(minute(at, close=close, volume="3"),))))


def check(composite, **fields):
    return data_sync(DataQuery(instrument=composite, series_kind="composite", timeframe="M1",
        limit=3, track_history=True, provisional=False, **fields))["history_check"]


def test_prefix_stamp_ignores_appends_and_excluded_latest_bucket_but_detects_older_correction(database, monkeypatch):
    composite, revision, seam = populated(database, monkeypatch)
    initial = check(composite, revision_after=seam)
    assert initial["before"] == seam + 540000
    with database.begin() as db:
        correction(db, revision, seam + 600000, 200001000)
    appended = check(composite, revision_after=seam, revision_before=initial["before"])
    assert appended["revision"] == initial["revision"]
    with database.begin() as db:
        correction(db, revision, seam + 540000, 200002000, "1.115")
    latest = check(composite, revision_after=seam, revision_before=initial["before"])
    assert latest["revision"] == initial["revision"]
    with database.begin() as db:
        correction(db, revision, seam + 60000, 200003000, "1.115")
    revised = check(composite, revision_after=seam, revision_before=initial["before"])
    assert revised["revision"] != initial["revision"]
    fixed = check(composite, revision_after=seam, revision_before=initial["before"], input_revision=1)
    assert fixed["revision"] == initial["revision"]


def test_outside_loaded_range_does_not_reset_but_correction_inside_does(database, monkeypatch):
    composite, revision, seam = populated(database, monkeypatch)
    initial = check(composite, revision_after=seam + 300000)
    with database.begin() as db:
        correction(db, revision, seam + 60000, 200001000, "1.115")
    assert check(composite, revision_after=seam + 300000)["revision"] == initial["revision"]
    with database.begin() as db:
        correction(db, revision, seam + 480000, 200002000, "1.115")
    assert check(composite, revision_after=seam + 300000)["revision"] != initial["revision"]


def test_gap_fill_inside_loaded_prefix_changes_stamp(database, monkeypatch):
    composite, revision, seam = populated(database, monkeypatch)
    with database.begin() as db:
        correction(db, revision, seam + 840000, 200001000)
    initial = check(composite, revision_after=seam)
    with database.begin() as db:
        correction(db, revision, seam + 780000, 200002000)
    assert check(composite, revision_after=seam)["revision"] != initial["revision"]


def test_high_period_check_uses_real_bucket_starts_and_excludes_entire_tail_bucket(database, monkeypatch):
    composite, revision, seam = populated(database, monkeypatch)
    query = dict(instrument=composite, series_kind="composite", timeframe="M5", limit=3,
                 track_history=True, provisional=False, revision_after=seam)
    initial = data_sync(DataQuery(**query))["history_check"]
    assert initial["before"] == seam + 300000
    with database.begin() as db:
        correction(db, revision, seam + 360000, 200001000, "1.115")
    assert data_sync(DataQuery(**query))["history_check"]["revision"] == initial["revision"]
    with database.begin() as db:
        correction(db, revision, seam + 60000, 200002000, "1.115")
    assert data_sync(DataQuery(**query))["history_check"]["revision"] != initial["revision"]


def test_immutable_history_check_stays_on_original_input(database, monkeypatch):
    parent = fixture(database, monkeypatch)
    args = dict(instrument=parent, series_kind="history", timeframe="M1", limit=3, track_history=True)
    initial = data_sync(DataQuery(**args))["history_check"]
    from test_composite_definitions import publish

    publish(database, end=259320000)
    assert data_sync(DataQuery(**args))["history_check"] == initial
    assert data_sync(DataQuery(**{**args, "track_history": False}))["history_check"] is None
