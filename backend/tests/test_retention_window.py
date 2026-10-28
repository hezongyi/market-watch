"""A13a/A13b/A13c contracts for the 30-day live-minute cleanup (real FKs on SQLite).

The shared contracts below are reused by the PostgreSQL suite, so every helper
takes an explicit sessionmaker instead of pytest fixtures.
"""

from pathlib import Path

import pytest
from alerts import backup as backup_module
from alerts import retention_window as window
from alerts import storage, switch_runs
from alerts.storage import (
    ChartAlert,
    ChartAlertVersion,
    CompositeInputEvent,
    CompositeMinute,
    CompositeMinuteInput,
    CompositePreparation,
    CompositeRevision,
    HistoryVersion,
    Instrument,
    MarketComposite,
    MarketDataset,
    MarketSwitchRun,
    RealtimeMapping,
    SourceMinute,
    SourceMinuteRevision,
    SourceSeries,
    uid,
)
from sqlalchemy import create_engine, event, func, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

NOW = 1_800_000_000_000
DAY = 86_400_000
LOWER = NOW - window.WINDOW_MS
OLD = LOWER - 1
BOUNDARY = LOWER
RECENT = LOWER + 1
ZERO = {name: 0 for name in window.DELETION_ORDER}


@pytest.fixture
def runtime(monkeypatch):
    """In-memory SQLite with foreign keys enforced, like production PostgreSQL."""
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)

    @event.listens_for(engine, "connect")
    def _foreign_keys(dbapi, _record):
        dbapi.execute("PRAGMA foreign_keys=ON")

    storage.bootstrap(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(storage, "Session", factory)
    try:
        yield factory
    finally:
        engine.dispose()


def graph(factory, starts=(OLD,)):
    """One composite whose superseded revision owns live minutes at the starts."""
    with factory.begin() as db:
        db.add(Instrument(id="TRET", label="Retention test", symbol="tret",
                          calendar="forex", precision=5))
        db.flush()
        db.add(MarketDataset(id="ds", instrument_id="TRET", logical_symbol="TRET",
                             identity={}, volume_kind="quantity"))
        db.flush()
        db.add(SourceSeries(id="src", identity={"source": "oanda"}))
        db.flush()
        db.add(RealtimeMapping(id="map", dataset_id="ds", target_dataset_id="ds",
                               permission_scope="market", match={}))
        db.add(HistoryVersion(id="hist", dataset_id="ds", start=0, end=DAY, cursor=DAY))
        db.flush()
        db.add(MarketComposite(id="comp", instrument_id="TRET", dataset_id="ds",
                               mapping_id="map", permission_scope="market", rules={},
                               active_revision_id="rev-active"))
        db.flush()
        for revision in ("rev-active", "rev-old"):
            db.add(CompositeRevision(id=revision, composite_id="comp",
                                     history_version_id="hist", mapping_id="map", seam=0,
                                     rules={}, request_id=revision))
        db.flush()
        for revision in ("rev-active", "rev-old"):
            db.add(CompositePreparation(revision_id=revision, status="queried", cursor=0,
                                        cutoff=0, confirmed_end=0, input_revision=0))
    for start in starts:
        minute(factory, start)


def minute(factory, start, *, revision="rev-old", source_id="src"):
    """A confirmed source minute plus the composite rows that reference it."""
    with factory.begin() as db:
        source = SourceMinuteRevision(id=uid(), source_id=source_id, start=start,
                                      data={"close": "1.1000"}, observed_at=start)
        db.add(source)
        db.flush()
        db.add(SourceMinute(source_id=source_id, start=start, revision_id=source.id,
                            last_observed_at=start))
        event = CompositeInputEvent(id=uid(), revision_id=revision, input_revision=start,
                                    input_manifest={"source_revision_id": source.id})
        db.add(event)
        db.flush()
        db.add(CompositeMinute(revision_id=revision, start=start,
                               source_revision_id=source.id))
        db.add(CompositeMinuteInput(revision_id=revision, start=start,
                                    input_revision=start, event_id=event.id,
                                    source_revision_id=source.id))
        return source.id


def run(factory, state="succeeded"):
    with factory.begin() as db:
        row = MarketSwitchRun(kind="weekly", composite_id="comp", scheduled_for=NOW,
                              state="preparing")
        db.add(row)
        db.flush()
        run_id = row.id
    steps = {
        "preparing": (),
        "failed": ("failed",),
        "partial": ("shadow_ready", "activating", "partial"),
        "shadow_ready": ("shadow_ready",),
        "activating": ("shadow_ready", "activating"),
        "succeeded": ("shadow_ready", "activating", "succeeded"),
    }[state]
    for step in steps:
        switch_runs.set_state(run_id, step)
    return run_id


def drill():
    """Record an already-verified restore drill against the current schema."""
    signature = window.schema_signature()
    return window.save_restore_drill({
        "artifact": "/tmp/retention-drill.db",
        "sha256": "0" * 64,
        "verified_at": NOW,
        "tables": signature["tables"],
        "backend": "sqlite",
        "schema": signature,
    })


def counts(factory):
    with factory.begin() as db:
        return {
            "minutes": db.scalar(select(func.count()).select_from(SourceMinute)),
            "revisions": db.scalar(select(func.count()).select_from(SourceMinuteRevision)),
            "composite_minutes": db.scalar(select(func.count()).select_from(CompositeMinute)),
            "composite_inputs": db.scalar(
                select(func.count()).select_from(CompositeMinuteInput)),
            "events": db.scalar(select(func.count()).select_from(CompositeInputEvent)),
        }


def starts_at(factory):
    with factory.begin() as db:
        return sorted(db.scalars(select(SourceMinute.start)))


def contract_window_boundary(factory):
    """Only a start strictly earlier than the bound leaves; the bound survives."""
    graph(factory, starts=(OLD, BOUNDARY, RECENT))
    run_id = run(factory)
    drill()
    report = window.execute(run_id, now=NOW)
    assert report["lower_bound"] == LOWER
    assert report["deleted"] == {
        "market_composite_minute_inputs": 1,
        "market_composite_minutes": 1,
        "market_composite_input_events": 1,
        "market_source_minutes": 1,
        "market_source_minute_revisions": 1,
    }
    assert starts_at(factory) == [BOUNDARY, RECENT]


def contract_unlock_requires_persisted_success(factory):
    """Failed, partial, preparing and in-flight runs never unlock deletion."""
    graph(factory, starts=(OLD,))
    drill()
    for state in ("preparing", "failed", "partial", "shadow_ready", "activating"):
        run_id = run(factory, state)
        report = window.execute(run_id, now=NOW)
        assert report["deleted"] == ZERO
        assert report["skipped"][0]["reason"] == "switch_run_" + state
        with pytest.raises(ValueError, match="succeeded"):
            switch_runs.claim_retention(run_id, dry_run=False)
    idle = window.execute(None, now=NOW)
    assert idle["skipped"][0]["reason"] == "no_succeeded_switch_run"
    assert counts(factory)["minutes"] == 1


def contract_dry_run_reports_and_deletes_nothing(factory):
    """A dry run needs no drill, reports rows/bytes and never removes a row."""
    graph(factory, starts=(OLD, OLD - 60_000))
    run_id = run(factory)
    before = counts(factory)
    report = window.dry_run(run_id, now=NOW)
    assert report["deleted"] == ZERO
    assert report["candidates"] == {"source_minutes": 2, "source_revisions": 2,
                                    "composite_minutes": 2, "composite_inputs": 2,
                                    "composite_input_events": 2}
    assert report["rows"] == 10
    assert report["bytes"] > report["payload_bytes"] > 0
    assert report["batch"]["dry_run"] is True
    assert window.restore_marker() is None
    assert counts(factory) == before
    assert window.dry_run(run_id, now=NOW)["rows"] == report["rows"]
    assert counts(factory) == before


def contract_foreign_key_order_and_idempotent_rerun(factory):
    """Dependents leave before their source revision, and a rerun deletes nothing."""
    graph(factory, starts=(OLD, OLD - 60_000))
    run_id = run(factory)
    drill()
    report = window.execute(run_id, now=NOW)
    assert report["deleted"]["market_composite_minute_inputs"] == 2
    assert report["deleted"]["market_composite_minutes"] == 2
    assert report["deleted"]["market_composite_input_events"] == 2
    assert report["deleted"]["market_source_minutes"] == 2
    assert report["deleted"]["market_source_minute_revisions"] == 2
    assert counts(factory) == {"minutes": 0, "revisions": 0, "composite_minutes": 0,
                               "composite_inputs": 0, "events": 0}
    again = window.execute(run_id, now=NOW)
    assert again["skipped"][0]["reason"] == "batch_completed"
    assert again["idempotent"] is True
    assert again["deleted"] == ZERO
    assert again["batch"]["stats"]["deleted"]["market_source_minutes"] == 2
    assert counts(factory) == {"minutes": 0, "revisions": 0, "composite_minutes": 0,
                               "composite_inputs": 0, "events": 0}


def contract_interrupted_pass_resumes(factory):
    """An interrupted batch resumes on the same batch without double counting."""
    graph(factory, starts=(OLD, OLD - 60_000, OLD - 120_000))
    run_id = run(factory)
    drill()
    original = window._delete
    calls = []

    def flaky(db, plan):
        calls.append(len(plan["deletable"]))
        if len(calls) == 2:
            raise RuntimeError("simulated interruption")
        return original(db, plan)

    window._delete = flaky
    try:
        with pytest.raises(RuntimeError, match="interruption"):
            window.execute(run_id, now=NOW, chunk=1)
    finally:
        window._delete = original
    interrupted = switch_runs.get(run_id)["retention"]
    assert interrupted["state"] == "interrupted"
    assert interrupted["stats"]["deleted"]["market_source_minutes"] == 1
    assert counts(factory)["minutes"] == 2
    resumed = window.execute(run_id, now=NOW, chunk=1)
    assert resumed["batch"]["attempts"] >= 2
    assert resumed["deleted"]["market_source_minutes"] == 2
    assert resumed["deleted"]["market_source_minute_revisions"] == 2
    final = switch_runs.get(run_id)["retention"]
    assert final["state"] == "completed"
    assert final["stats"]["deleted"]["market_source_minutes"] == 3
    assert final["stats"]["rows"] == 15
    assert counts(factory) == {"minutes": 0, "revisions": 0, "composite_minutes": 0,
                               "composite_inputs": 0, "events": 0}


def contract_mixed_batch_deletes_only_unprotected(factory):
    """Protected candidates stay, safe ones leave, and one pass never rescans them."""
    graph(factory, starts=(OLD, OLD - 60_000))
    with factory.begin() as db:
        db.add(CompositeRevision(id="rev-frozen", composite_id="comp",
                                 history_version_id="hist", mapping_id="map", seam=0,
                                 rules={}, request_id="rev-frozen"))
        db.flush()
        db.add(CompositePreparation(revision_id="rev-frozen", status="queried", cursor=0,
                                    cutoff=0, confirmed_end=0, input_revision=0))
        db.add(ChartAlert(id="alert", request_id="req-2", request_hash="hash", name="watch",
                          status="active", effective_at=NOW))
        db.add(ChartAlertVersion(alert_id="alert", version=1,
                                 config={"series_kind": "composite"},
                                 market_identity={"composite_revision_id": "rev-frozen"},
                                 effective_at=NOW))
    frozen = minute(factory, OLD - 120_000, revision="rev-frozen")
    run_id = run(factory)
    drill()
    report = window.execute(run_id, now=NOW, chunk=1)
    assert report["deleted"]["market_source_minutes"] == 2
    assert report["deleted"]["market_source_minute_revisions"] == 2
    assert report["protected"]["by_reason"] == {"active_alert_old_revision": 1}
    assert report["batch"]["attempts"] <= 6
    with factory.begin() as db:
        survivor = db.get(SourceMinuteRevision, frozen)
        assert survivor is not None and survivor.start == OLD - 120_000
    assert OLD - 120_000 in starts_at(factory)


def contract_active_alert_blocks_the_batch(factory):
    """An active alert still bound to the old revision skips that whole batch."""
    graph(factory, starts=(OLD,))
    with factory.begin() as db:
        db.add(ChartAlert(id="alert", request_id="req-1", request_hash="hash", name="watch",
                          status="active", effective_at=NOW))
        db.add(ChartAlertVersion(alert_id="alert", version=1,
                                 config={"series_kind": "composite"},
                                 market_identity={"composite_revision_id": "rev-old"},
                                 effective_at=NOW))
    run_id = run(factory)
    drill()
    report = window.execute(run_id, now=NOW)
    assert report["deleted"] == ZERO
    assert report["protected"]["by_reason"] == {"active_alert_old_revision": 1}
    assert report["protected"]["detail"][0]["revision_id"] != ""
    assert counts(factory)["minutes"] == 1
    with factory.begin() as db:
        db.get(ChartAlert, "alert").status = "archived"
    second = run(factory)
    cleared = window.execute(second, now=NOW)
    assert cleared["deleted"]["market_source_minutes"] == 1
    assert counts(factory)["minutes"] == 0


def contract_restore_gate_blocks_real_deletion(factory):
    """No drill, or a drill from another schema, refuses every real deletion."""
    graph(factory, starts=(OLD,))
    run_id = run(factory)
    missing = window.execute(run_id, now=NOW)
    assert missing["skipped"][0]["reason"] == "restore_drill_missing"
    assert missing["deleted"] == ZERO
    assert counts(factory)["minutes"] == 1
    assert window.dry_run(run_id, now=NOW)["rows"] == 5
    window.save_restore_drill({
        "artifact": "/tmp/stale.db",
        "sha256": "1" * 64,
        "verified_at": NOW,
        "tables": 1,
        "backend": "sqlite",
        "schema": {"tables": -1, "digest": "stale", "alembic": None},
    })
    stale = window.execute(run_id, now=NOW)
    assert stale["skipped"][0]["reason"] == "restore_drill_schema_mismatch"
    assert counts(factory)["minutes"] == 1
    drill()
    assert window.execute(run_id, now=NOW)["deleted"]["market_source_minutes"] == 1


def contract_tick_reports_reasons(factory):
    """The tick layer refuses every run that is not a persisted success."""
    assert window.tick(now=NOW)["reason"] == "no_switch_run"
    graph(factory, starts=(OLD,))
    run(factory, "failed")
    refused = window.tick(now=NOW)
    assert refused["unlocked"] is False and refused["reason"] == "no_unlocked_batch"
    assert [item["reason"] for item in refused["runs"]] == ["switch_run_failed"]
    run(factory)
    drill()
    planned = window.tick(now=NOW)
    assert planned["unlocked"] is True
    assert planned["report"]["deleted"] == ZERO
    assert counts(factory)["minutes"] == 1
    worked = window.tick(dry_run=False, now=NOW)
    assert worked["report"]["deleted"]["market_source_minutes"] == 1
    assert counts(factory)["minutes"] == 0


def test_window_boundary(runtime):
    contract_window_boundary(runtime)


def test_unlock_requires_persisted_success(runtime):
    contract_unlock_requires_persisted_success(runtime)


def test_dry_run_reports_and_deletes_nothing(runtime):
    contract_dry_run_reports_and_deletes_nothing(runtime)


def test_foreign_key_order_and_idempotent_rerun(runtime):
    contract_foreign_key_order_and_idempotent_rerun(runtime)


def test_interrupted_pass_resumes(runtime):
    contract_interrupted_pass_resumes(runtime)


def test_mixed_batch_deletes_only_unprotected(runtime):
    contract_mixed_batch_deletes_only_unprotected(runtime)


def test_active_alert_blocks_the_batch(runtime):
    contract_active_alert_blocks_the_batch(runtime)


def test_restore_gate_blocks_real_deletion(runtime):
    contract_restore_gate_blocks_real_deletion(runtime)


def test_tick_reports_reasons(runtime):
    contract_tick_reports_reasons(runtime)


def test_restore_drill_runs_a_real_backup_and_restore_check(tmp_path, monkeypatch):
    """The hard gate is written by a real backup plus a real restore verification."""
    source = tmp_path / "source.db"
    engine = create_engine("sqlite:///" + str(source))

    @event.listens_for(engine, "connect")
    def _foreign_keys(dbapi, _record):
        dbapi.execute("PRAGMA foreign_keys=ON")

    storage.bootstrap(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(storage, "Session", factory)
    monkeypatch.setattr(backup_module.settings, "database_url", "sqlite:///" + str(source))
    try:
        graph(factory, starts=(OLD,))
        run_id = run(factory)
        marker = window.restore_drill(tmp_path / "drill")
        assert Path(marker["artifact"]).is_file()
        assert len(marker["sha256"]) == 64
        assert marker["tables"] == window.schema_signature()["tables"]
        assert marker["verified_at"] > 0
        assert window.restore_marker()["sha256"] == marker["sha256"]
        report = window.execute(run_id, now=NOW)
        assert report["deleted"]["market_source_minutes"] == 1
        assert counts(factory)["minutes"] == 0
    finally:
        engine.dispose()
