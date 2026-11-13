"""Identical nine-period outputs with bounded shared worker input preparation."""

from alerts import composite_aggregates as aggregates
from alerts.composite_aggregate_inputs import AggregateInputs
from alerts.composite_inputs import rows
from alerts.storage import CompositeRevision
from sqlalchemy import event, select
from test_composite_chart import populated


def test_shared_preparation_preserves_all_periods_and_reduces_queries(database, monkeypatch):
    _, revision, _ = populated(database, monkeypatch)
    from alerts.chart_data import FRAMES

    ownerships = [aggregates.claim(revision, frame) for frame in FRAMES]
    assert all(ownerships)
    engine = database.kw["bind"]
    queries = []
    def counted(*args):
        queries.append(args[2])
    event.listen(engine, "before_cursor_execute", counted)
    try:
        baseline = [aggregates.build(owner) for owner in ownerships]
        old_count = len(queries)
        queries.clear()
        shared = AggregateInputs()
        candidate = []
        for owner in ownerships:
            shared.begin(owner)
            candidate.append(aggregates.build(owner, prepared=shared))
        new_count = len(queries)
        assert candidate == baseline
        assert new_count < old_count
        assert shared.claims == 9
        shared.begin(ownerships[0])
        assert shared.claims == 1 and shared.metadata is None
        print(f"nine-period build SQL: independent={old_count}, shared={new_count}")
    finally:
        event.remove(engine, "before_cursor_execute", counted)


def test_shared_delta_is_pinned_and_read_once_for_different_period_windows(database, monkeypatch):
    composite, revision, seam = populated(database, monkeypatch)
    shared = AggregateInputs()
    shared.begin({"composite_id": composite, "revision_id": revision, "input_revision": 1,
                  "permission_scope": "workspace:default"})
    with database() as db:
        expected = list(rows(db, revision, seam, seam + 600000, input_revision=1, now=200010000))
        first = shared.delta(db, revision, 0, 1, seam, seam + 600000, now=200010000)
        assert first == expected
        # After initial reconstruction no other period re-queries that delta.
        def forbidden(*_args, **_kwargs):
            raise AssertionError("another period must reuse the same fixed-input minutes")
        monkeypatch.setattr(db, "scalars", forbidden)
        assert shared.delta(db, revision, 0, 1, seam + 60000, seam + 120000, now=200010000) == expected[1:2]
    # A new input version cannot retain metadata or the old minute window.
    shared.begin({"composite_id": composite, "revision_id": revision, "input_revision": 2,
                  "permission_scope": "workspace:default"})
    assert shared.metadata is None and not shared.delta_rows


def test_shared_worker_keeps_task_leases_and_independent_period_commits(database, monkeypatch):
    _, revision, _ = populated(database, monkeypatch)
    shared = AggregateInputs()
    for frame in ("M1", "M5", "H1"):
        assert aggregates.aggregate_tick(revision, frame, prepared=shared)
    with database() as db:
        row = db.get(CompositeRevision, revision)
        assert row.id == revision
    # Ordinary fixed readers and independent workers still use the old seam.
    assert aggregates.aggregate_tick(revision, "M1")


def test_new_input_and_expired_owner_cannot_change_shared_fixed_results(database, monkeypatch):
    import pytest
    from alerts.storage import CompositeAggregateTask
    from test_fixed_series_revisions import correction

    _, revision, seam = populated(database, monkeypatch)
    shared = AggregateInputs()
    old = aggregates.claim(revision, "M1")
    shared.begin(old)
    expected = aggregates.build(old, prepared=shared)
    with database.begin() as db:
        correction(db, revision, seam + 600000, 200001000)
        db.get(CompositeAggregateTask, (revision, "M1")).lease_until = 0
    assert aggregates.build(old, prepared=shared) == expected
    successor = aggregates.claim(revision, "M1")
    with pytest.raises(TimeoutError):
        aggregates.commit(old, expected)
    shared.begin(successor)
    aggregates.commit(successor, aggregates.build(successor, prepared=shared))
    # New input waits for a separate owned claim/version; a warm batch cannot
    # advance the task to newer input just because it arrived during the read.
    with database() as db:
        assert db.get(CompositeAggregateTask, (revision, "M1")).applied_input_revision == old["input_revision"]


def test_failed_period_clears_shared_inputs_but_other_periods_continue(database, monkeypatch):
    from alerts.storage import CompositeAggregateTask

    _, revision, _ = populated(database, monkeypatch)
    shared = AggregateInputs()
    build = aggregates.build
    def fail_one(owner, **kwargs):
        if owner["timeframe"] == "M5":
            raise RuntimeError("one failed period")
        return build(owner, **kwargs)
    monkeypatch.setattr(aggregates, "build", fail_one)
    assert aggregates.aggregate_tick(revision, "M1", prepared=shared)
    assert aggregates.aggregate_tick(revision, "M5", prepared=shared)
    assert shared.key is None
    assert aggregates.aggregate_tick(revision, "H1", prepared=shared)
    with database() as db:
        assert db.get(CompositeAggregateTask, (revision, "M5")).error == "RuntimeError"
        assert db.get(CompositeAggregateTask, (revision, "H1")).error is None
        assert db.get(CompositeAggregateTask, (revision, "H1")).applied_input_revision == 0


def three_populated(database, monkeypatch):
    """The three reviewed OANDA products, each with its own immutable identity."""
    from alerts.composite_definitions import first_use, save_mapping
    from alerts.composite_inputs import apply_minutes
    from alerts.composite_matching import check_match
    from alerts.confirmed_minutes import record
    from alerts.history_artifacts import artifact_tick
    from alerts.history_catalog import account_scope
    from alerts.history_maintenance import configure
    from alerts.history_versions import create_version, import_page
    from alerts.market_contracts import DatasetIdentity
    from alerts.realtime_switch import set_enabled
    from alerts.storage import MarketCatalog, MarketDataset, RealtimeMapping
    from test_history_versions import Adapter
    from test_market_contracts import batch, identity, minute
    from test_market_datasets import register

    output = [populated(database, monkeypatch)]
    with database.begin() as db:
        configure(db, identity().key, target_start=0, timeframes=["M1"])
    for historical, live, kind, precision in (("USD/CAD", "USD_CAD", "CURRENCY", 5), ("XAU/USD", "XAU_USD", "METAL", 3)):
        ident = identity(provider_symbol=historical)
        with database.begin() as db:
            register(db, ident, logical_symbol=live.replace("_", ""), precision=precision)
            dataset = db.get(MarketDataset, ident.key)
            configure(db, dataset.id, target_start=0, timeframes=["M1"])
            catalog_id = "HC:" + live
            db.add(MarketCatalog(id=catalog_id, source="oanda", symbol=live, label=live, asset_type=kind,
                precision=precision, calendar="ny17", metadata_json={"history_account_scope": account_scope()}))
            parent = create_version(db, ident.key, 0, 172920000)
        import_page(Adapter([batch(identity=ident, window_end=172920000, checkpoint=172920000,
            rows=tuple(minute(at) for at in (0, 60000, 172800000, 172860000)))]), version_id=parent)
        while artifact_tick(parent):
            pass
        with database.begin() as db:
            match = check_match(db, ident.key, catalog_id)
            mapping = save_mapping(db, ident.key, catalog_id, {**match["suggestion"], "reviewed": True}, snapshot=match["snapshot"])
            composite = first_use(db, ident.key, mapping.id)
            revision = db.get(CompositeRevision, composite.active_revision_id)
            target = db.get(MarketDataset, db.get(RealtimeMapping, revision.mapping_id).target_dataset_id)
            seam = revision.seam
            apply_minutes(db, record(db, batch(identity=DatasetIdentity.model_validate(target.identity),
                window_start=seam, window_end=seam + 600000, checkpoint=seam + 600000, observed_at=seam + 600000,
                volume_kind="price_count", volume_unit="quotes", rows=tuple(
                    minute(at, volume="3") for at in range(seam, seam + 600000, 60000)))))
            set_enabled(db, dataset.instrument_id, True, now=seam)
            output.append((composite.id, revision.id, seam))
    return output


def test_three_identities_nine_periods_have_identical_confirmed_outputs(database, monkeypatch):
    import statistics
    import time

    from alerts.chart_data import FRAMES
    from alerts.composite_realtime import CurrentBuckets
    from alerts.dataset_summaries import summaries
    from alerts.storage import CompositeAggregateTask, MarketComposite

    identities = three_populated(database, monkeypatch)
    # Complete the seam-only seeds so this measurement includes real confirmed
    # tail input at version 1, not just metadata reuse of empty live windows.
    owners = []
    for _, revision, _ in identities:
        for frame in FRAMES:
            assert aggregates.aggregate_tick(revision, frame)
            owners.append(aggregates.claim(revision, frame))
    assert len(owners) == 27 and all(owner["input_revision"] == 1 for owner in owners)
    timings = {"independent": [], "shared": []}
    counts = {}
    expected = None
    engine = database.kw["bind"]
    statements = []
    def counted(*args):
        statements.append(args[2])
    event.listen(engine, "before_cursor_execute", counted)
    try:
        for _ in range(3):
            for mode in ("independent", "shared"):
                shared, buckets = AggregateInputs(), CurrentBuckets()
                statements.clear()
                started = time.process_time()
                result = []
                for owner in owners:
                    if mode == "shared":
                        shared.begin(owner)
                    result.append(aggregates.build(owner, realtime=buckets,
                        prepared=shared if mode == "shared" else None))
                timings[mode].append(time.process_time() - started)
                counts[mode] = len(statements)
                if expected is None:
                    expected = result
                assert result == expected
        assert counts["shared"] < counts["independent"]
        # Summary reads are bounded for both one and three configured datasets.
        with database() as db:
            dataset_ids = list(db.scalars(select(MarketComposite.dataset_id)))
        statements.clear()
        with database() as db:
            one = summaries(db, ids=dataset_ids[0])
        one_count = len(statements)
        statements.clear()
        with database() as db:
            all_rows = summaries(db)
            assert len(all_rows["items"]) == 3 and one["total"] == 3
            for row in all_rows["items"]:
                assert row["continuation"]["enabled"]
                assert row["continuation"]["status"] == "preparing"
            for owner in owners:
                assert db.get(CompositeAggregateTask, (owner["revision_id"], owner["timeframe"])).applied_input_revision == 0
        all_count = len(statements) - 27  # Task assertions above are outside summary cost.
        assert all_count <= one_count + 1
        print("three identities × nine confirmed periods", {"SQL": counts,
            "median_cpu_seconds": {mode: round(statistics.median(values), 4) for mode, values in timings.items()},
            "configured_summary_SQL": {"one": one_count, "three": all_count}})
    finally:
        event.remove(engine, "before_cursor_execute", counted)


def test_frozen_revision_rejects_warm_shared_build_commit(database, monkeypatch):
    import pytest
    from alerts.storage import CompositeAggregateTask, CompositePreparation

    _, revision, _ = populated(database, monkeypatch)
    owner = aggregates.claim(revision, "M1")
    shared = AggregateInputs()
    shared.begin(owner)
    output = aggregates.build(owner, prepared=shared)
    with database.begin() as db:
        prep = db.get(CompositePreparation, revision)
        prep.state = {**prep.state, "revision_frozen": True}
    with pytest.raises(aggregates.Fenced):
        aggregates.commit(owner, output)
    with database() as db:
        assert db.get(CompositeAggregateTask, (revision, "M1")).applied_input_revision == -1
    assert aggregates.claim(revision, "H1") is None
