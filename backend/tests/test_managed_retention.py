"""Daily/source cleanup identity and reference protection, fixture clocks only."""

import pytest
from alerts import retention_window as window
from alerts import switch_runs
from alerts.config import settings
from alerts.storage import (
    CompositeRevision,
    HistoryArtifact,
    HistoryArtifactBlock,
    HistoryVersion,
    MarketDemand,
    MarketSwitchRun,
    Preference,
    Replay,
)
from sqlalchemy import select, update
from test_retention_window import (
    DAY,
    LOWER,
    NOW,
    OLD,
    counts,
    run,
)
from test_retention_window import (
    graph as base_graph,
)
from test_retention_window import runtime as _runtime

runtime = _runtime


def graph(factory, starts=(OLD,)):
    """Explicit old live rows plus a readable current fixed baseline fixture."""
    import gzip
    import hashlib
    import json
    base_graph(factory, starts=starts)
    with factory.begin() as db:
        db.execute(update(HistoryVersion).where(HistoryVersion.id == "hist").values(
            status="published", end=NOW, manifest={"checksum": "fixture-parent"}))
        db.execute(update(CompositeRevision).where(CompositeRevision.id == "rev-active")
                   .values(seam=NOW - DAY))
        manifest = {"parent_version_id": "hist", "parent_checksum": "fixture-parent",
                    "timeframe": "M1", "rule_version": "fixture"}
        db.add(HistoryArtifact(id="fixed-m1", version_id="hist", timeframe="M1",
            rule_version="fixture", status="published", cursor=NOW,
            count=1, complete_count=1, manifest=manifest))
        db.flush()
        rows = [{"start": NOW - DAY - 60000, "end": NOW - DAY,
                 "open": "1.1", "high": "1.1", "low": "1.1", "close": "1.1",
                 "complete": True}]
        raw = json.dumps(rows).encode()
        db.add(HistoryArtifactBlock(artifact_id="fixed-m1", start=rows[0]["start"],
            end=rows[0]["end"], count=1, checksum=hashlib.sha256(raw).hexdigest(),
            content=gzip.compress(raw)))


def test_daily_dry_run_deduplicates_source_date_and_next_day_runs_without_new_switch(runtime, monkeypatch):
    monkeypatch.setattr(settings, "managed_rollover_enabled", True)
    graph(runtime, starts=(OLD, LOWER, LOWER + DAY // 2))
    ident = run(runtime)
    before = counts(runtime)
    first = window.tick(dry_run=True, now=NOW)
    assert first["report"]["candidates"]["source_minutes"] == 1
    assert first["report"]["batch_key"].endswith(":dry_run")
    assert not window.tick(dry_run=True, now=NOW + 1000)["unlocked"]
    second = window.tick(dry_run=True, now=NOW + DAY)
    assert second["report"]["candidates"]["source_minutes"] == 3
    assert second["report"]["batch_key"] != first["report"]["batch_key"]
    assert counts(runtime) == before
    assert switch_runs.get(ident)["state"] == "succeeded"
    # Date batches are independent progress, not new fake succeeded switch runs.
    with runtime() as db:
        assert len(list(db.scalars(select(MarketSwitchRun)))) == 1
        assert len(list(db.scalars(select(Preference).where(
            Preference.key.startswith(window.DAILY_PREFIX))))) == 2


def test_execute_remains_separate_from_dry_run_and_keeps_restore_gate(runtime, monkeypatch):
    monkeypatch.setattr(settings, "managed_rollover_enabled", True)
    graph(runtime)
    run(runtime)
    before = counts(runtime)
    dry = window.tick(dry_run=True, now=NOW)
    real = window.tick(dry_run=False, now=NOW)
    assert dry["report"]["batch_key"] != real["report"]["batch_key"]
    assert real["report"]["skipped"][0]["reason"] == "restore_drill_missing"
    assert counts(runtime) == before


def test_more_than_twenty_new_failed_runs_cannot_hide_older_succeeded_source(runtime, monkeypatch):
    monkeypatch.setattr(settings, "managed_rollover_enabled", True)
    graph(runtime)
    ident = run(runtime)
    for index in range(25):
        row = switch_runs.start("revision_activation", composite_id="other", scheduled_for=NOW + index)
        switch_runs.set_state(row["id"], "failed")
    result = window.tick(dry_run=True, now=NOW)
    assert result["unlocked"]
    assert result["runs"][0]["id"] == ident


def test_active_fixed_reader_and_replay_protect_old_live_inputs(runtime):
    graph(runtime)
    run_id = run(runtime)
    with runtime.begin() as db:
        db.add(MarketDemand(id="fixed-reader", instrument_id="TRET",
            composite_revision_id="rev-old", expires=NOW + DAY))
        db.add(Replay(id="fixed-replay", instrument_id="TRET", timeframe="M1",
            start=OLD, end=NOW, cursor=OLD, bars=[], days=[],
            input_manifest={"composite_revision_id": "rev-old"}))
    report = window.dry_run(run_id, now=NOW)
    reasons = report["protected"]["by_reason"]
    assert reasons["active_fixed_reader"] and reasons["replay_fixed_input"]
    assert report["deletable_revisions"] == 0


def test_same_source_multiple_switches_share_one_daily_batch(runtime, monkeypatch):
    monkeypatch.setattr(settings, "managed_rollover_enabled", True)
    graph(runtime)
    run(runtime)
    extra = switch_runs.start("revision_activation", composite_id="comp", scheduled_for=NOW + 1,
        previous_revision_id="rev-old", target_revision_id="rev-active")
    for state in ("shadow_ready", "activating", "succeeded"):
        switch_runs.set_state(extra["id"], state)
    assert window.tick(dry_run=True, now=NOW)["unlocked"]
    assert not window.tick(dry_run=True, now=NOW)["unlocked"]
    with runtime() as db:
        assert len(list(db.scalars(select(Preference).where(
            Preference.key.startswith(window.DAILY_PREFIX))))) == 1


def aggregate_only_cleanup(factory):
    """Shared M1 survives, but losing a frozen aggregate fences new readers."""
    from alerts.fixed_indicators import request
    from alerts.history_retention import lock_reference_values
    from alerts.storage import CompositeAggregateBar, CompositeMinute, SourceMinute

    base_graph(factory)
    with factory.begin() as db:
        source = db.scalar(select(SourceMinute.revision_id))
        db.add(CompositeMinute(revision_id="rev-active", start=OLD, source_revision_id=source))
        db.add(CompositeAggregateBar(revision_id="rev-old", timeframe="M1", start=OLD,
            input_revision=0, data={"start": OLD, "end": LOWER, "close": "1.1"}))
    run_id = run(factory)
    switch_runs.claim_retention(run_id, dry_run=False)
    totals = {"rows": 0, "bytes": 0, "deleted": window._zero_deleted(), "blob_scan": {}}
    report = window._apply_chunk(run_id=run_id, lower=LOWER, limit=10, now=NOW,
        deadline=window.now_ms() + 30000, skip_minutes=(), skip_revisions=(), totals=totals)
    assert report["deleted"]["market_source_minutes"] == 0
    assert report["deleted"]["market_composite_aggregate_bars"] == 1
    with factory.begin() as db:
        with pytest.raises(ValueError, match="实时输入已清理"):
            lock_reference_values(db, {"composite_revision_id": "rev-old"})
        # This is the actual Core INSERT API, including its shared-lock fence.
        with pytest.raises(ValueError, match="实时输入已清理"):
            request(db, {"revision_id": "rev-old", "history_version_id": "hist", "timeframe": "M1"},
                    {"name": "EMA", "params": {"period": 19}})


def test_aggregate_only_cleanup_rejects_new_reader_and_indicator(runtime):
    aggregate_only_cleanup(runtime)
