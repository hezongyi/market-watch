"""Persisted periods preserve fixed inputs, corrections, seam and recovery."""

import pytest
from alerts import composite_aggregates as cache
from alerts.chart_data import FRAMES
from alerts.composite_chart import chart_page
from alerts.composite_series import read_window
from alerts.storage import CompositeAggregateBar, CompositeAggregateTask, CompositeRevision
from sqlalchemy import func, select
from test_composite_chart import populated
from test_fixed_series_revisions import correction


def drain(revision, frame):
    for _ in range(100):
        if not cache.aggregate_tick(revision, frame):
            return
    raise AssertionError("Period task did not finish")


def test_persisted_pages_match_stitched_inputs_and_skip_m1_reads(database, monkeypatch):
    composite, revision, seam = populated(database, monkeypatch)
    expected = {}
    with database.begin() as db:
        for frame in FRAMES:
            expected[frame] = chart_page(db, composite, frame, count=20, now=200010000)["bars"]
    for frame in FRAMES:
        drain(revision, frame)
    def forbidden(*args, **kwargs):
        raise AssertionError("Completed period cache must not reconstruct M1")
    monkeypatch.setattr("alerts.composite_chart.read_window", forbidden)
    with database.begin() as db:
        for frame in FRAMES:
            page = chart_page(db, composite, frame, count=20, now=200010000)
            assert page["bars"] == expected[frame]
            assert page["materialized"] and page["bounded_partitions"] == 0
        assert db.scalar(select(func.count()).select_from(CompositeAggregateTask)) == 9


def test_accepted_correction_invalidates_only_affected_buckets_and_old_inputs_remain(database, monkeypatch):
    composite, revision, seam = populated(database, monkeypatch)
    drain(revision, "M1")
    with database.begin() as db:
        old = chart_page(db, composite, "M1", count=20, input_revision=1, now=200010000)
        correction(db, revision, seam + 60000, 200001000, "1.115")
    with database.begin() as db:
        assert not chart_page(db, composite, "M1", count=20, now=200010000)["materialized"]
        assert chart_page(db, composite, "M1", count=20, input_revision=1, now=200010000)["bars"] == old["bars"]
    drain(revision, "M1")
    with database.begin() as db:
        page = chart_page(db, composite, "M1", count=20, now=200010000)
        assert page["materialized"] and page["input_revision"] == 2
        assert next(b for b in page["bars"] if b["start"] == seam + 60000)["close"] == "1.115"
        assert db.scalar(select(func.count()).select_from(CompositeAggregateBar).where(
            CompositeAggregateBar.input_revision == 2)) == 1
        assert chart_page(db, composite, "M1", count=20, input_revision=1, now=200010000)["bars"] == old["bars"]
    with pytest.raises(ValueError, match="immutable"):
        with database.begin() as db:
            db.scalar(select(CompositeAggregateBar)).data = {"changed": True}
            db.flush()


def test_expired_owner_cannot_publish_after_successor_and_next_event_arrival_is_preserved(database, monkeypatch):
    composite, revision, seam = populated(database, monkeypatch)
    old = cache.claim(revision, "M1")
    old_bars = cache.build(old)
    with database.begin() as db:
        db.get(CompositeAggregateTask, (revision, "M1")).lease_until = 0
    successor = cache.claim(revision, "M1")
    assert successor["token"] != old["token"]
    with pytest.raises(TimeoutError, match="superseded"):
        cache.commit(old, old_bars)
    with database.begin() as db:
        correction(db, revision, seam + 600000, 200001000)
    cache.commit(successor, cache.build(successor))
    drain(revision, "M1")
    with database.begin() as db:
        task = db.get(CompositeAggregateTask, (revision, "M1"))
        assert task.applied_input_revision == 2 and task.offset == 0
        assert chart_page(db, composite, "M1", now=200010000)["bars"][-1]["start"] == seam + 600000


def test_partial_event_checkpoint_does_not_publish_stale_page(database, monkeypatch):
    composite, revision, seam = populated(database, monkeypatch)
    monkeypatch.setattr(cache, "MAX_BUCKETS", 2)
    cache.aggregate_tick(revision, "M1")  # Version zero seam seed.
    cache.aggregate_tick(revision, "M1")
    with database.begin() as db:
        task = db.get(CompositeAggregateTask, (revision, "M1"))
        assert task.applied_input_revision == 0 and task.offset == 2
        assert not chart_page(db, composite, "M1", now=200010000)["materialized"]
    drain(revision, "M1")
    with database.begin() as db:
        assert chart_page(db, composite, "M1", now=200010000)["materialized"]
        assert db.get(CompositeAggregateTask, (revision, "M1")).offset == 0


def test_sparse_long_tail_and_exclusive_pages_use_persisted_buckets(database, monkeypatch):
    composite, revision, seam = populated(database, monkeypatch)
    times = [seam + day * 86400000 for day in (50, 100, 150)]
    with database.begin() as db:
        for i, at in enumerate(times):
            correction(db, revision, at, at + 100000 + i)
    drain(revision, "MN")
    with database.begin() as db:
        seen, before = [], None
        for _ in range(10):
            page = chart_page(db, composite, "MN", before=before, count=1, now=times[-1] + 100000)
            assert page["materialized"] and page["bounded_partitions"] == 0
            seen += [bar["start"] for bar in page["bars"]]
            before = page["next_before"]
            if before is None:
                break
        assert len(seen) == len(set(seen)) == 4


def test_bucket_time_closure_updates_without_new_input_and_pending_seam_is_retained(database, monkeypatch):
    composite, revision, seam = populated(database, monkeypatch)
    drain(revision, "M5")
    with database.begin() as db:
        early = chart_page(db, composite, "M5", count=2, now=seam + 330000)["bars"][-1]
        late = chart_page(db, composite, "M5", count=2, now=seam + 900000)["bars"][-1]
        assert not early["time_closed"] and late["time_closed"]
        assert early["source_confirmed"] == late["source_confirmed"]
        r = db.get(CompositeRevision, revision)
        check = read_window(db, composite, "M5", seam, seam + 600000, input_revision=1, now=seam + 900000)
        assert late == check["bars"][-1] and r.seam == seam


def test_failed_build_keeps_checkpoint_and_retry_recovers(database, monkeypatch):
    _, revision, _ = populated(database, monkeypatch)
    original = cache.build
    monkeypatch.setattr(cache, "build", lambda _: (_ for _ in ()).throw(RuntimeError("temporary failure")))
    assert cache.aggregate_tick(revision, "H4")
    with database.begin() as db:
        task = db.get(CompositeAggregateTask, (revision, "H4"))
        assert task.applied_input_revision == -1 and task.offset == 0
        assert task.error == "RuntimeError" and task.attempts == 1 and not task.lease_token
        task.next_at = 0
    monkeypatch.setattr(cache, "build", original)
    drain(revision, "H4")
    with database.begin() as db:
        task = db.get(CompositeAggregateTask, (revision, "H4"))
        assert task.applied_input_revision == 1 and task.error is None and task.attempts == 0


def test_materialized_page_overlays_only_valid_provisional_stream_and_never_persists_it(database, monkeypatch):
    from alerts import live_pricing as live
    from alerts.market_contracts import DatasetIdentity, QuoteEvent
    from alerts.storage import MarketDataset, PricingOwner, RealtimeMapping

    composite, revision_id, _ = populated(database, monkeypatch)
    drain(revision_id, "M1")
    with database.begin() as db:
        revision = db.get(CompositeRevision, revision_id)
        target = db.get(MarketDataset, db.get(RealtimeMapping, revision.mapping_id).target_dataset_id)
        ident = DatasetIdentity.model_validate(target.identity)
        count = db.scalar(select(func.count()).select_from(CompositeAggregateBar))
    owner = live.claim(live.settings.oanda_account_id, now=200010000)
    epoch = live.begin_connection(owner, {"EUR_USD": ident}, now=200010000)
    live.publish_event(owner, epoch, QuoteEvent(identity=ident, bid="1.10", ask="1.11",
        source_time=200005000, received_at=200006000, tradeable=True, connection_epoch=epoch, sequence=1),
        {"EUR_USD": ident}, now=200010000)
    with database.begin() as db:
        confirmed = chart_page(db, composite, "M1", count=3, input_revision=1, now=200010000)
        sampled = chart_page(db, composite, "M1", count=3, provisional=True, now=200010000)
        assert confirmed["materialized"] and sampled["materialized"]
        assert not sampled["bars"][-1]["source_confirmed"]
        assert sampled["bars"][-1]["start"] > confirmed["bars"][-1]["start"]
        assert sampled["bars"][-1]["segments"][0]["provisional_minutes"]
        assert db.scalar(select(func.count()).select_from(CompositeAggregateBar)) == count
        db.get(PricingOwner, owner[0]).expires = 0
    with database.begin() as db:
        expired = chart_page(db, composite, "M1", count=3, provisional=True, now=200010000)
        assert expired["bars"] == confirmed["bars"]
