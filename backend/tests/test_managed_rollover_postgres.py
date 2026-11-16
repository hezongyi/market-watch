"""Run the managed rotation contracts on task-owned PostgreSQL schemas."""

import os
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
import test_managed_rollover as contracts
from sqlalchemy import event, select, text
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg

pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated PostgreSQL")


@pytest.mark.parametrize("contract", [
    contracts.test_published_without_completed_maintenance_never_queues_a_candidate,
    contracts.test_required_unavailable_artifact_cannot_take_over,
    contracts.test_saved_mapping_is_used_even_when_another_reviewed_mapping_exists,
    contracts.test_candidate_catches_old_tail_and_activates_once_without_changing_identity,
    contracts.test_fixed_price_alert_defers_auto_activation_and_remains_active,
    contracts.test_new_fixed_rule_after_preflight_is_checked_again_at_activation,
    contracts.test_late_confirmation_invalidates_candidate_activation_input,
    contracts.test_disabling_realtime_or_automation_blocks_a_ready_candidate,
    contracts.test_latest_ineligible_history_does_not_hide_previous_eligible_result,
    contracts.test_same_day_correction_creates_only_one_new_candidate,
    contracts.test_substantial_missing_tail_with_unchanged_watermark_cannot_activate,
    contracts.test_newest_materially_degraded_fixed_history_does_not_hide_good_version,
], ids=lambda contract: contract.__name__)
def test_postgres_rotation(provider_pg, monkeypatch, contract):
    factory, _ = provider_pg
    contract(factory, monkeypatch)


@pytest.mark.parametrize("operation", ["edit", "resume", "evaluate"])
def test_alert_operations_take_dataset_fence_before_alert_lock(provider_pg, monkeypatch, operation):
    """A real activation owning datasets must never wait on this blocked writer."""
    from alerts import managed_rollover as rollover
    from alerts.chart_alert_service import Conflict, edit, lifecycle
    from alerts.chart_alert_worker import evaluate
    from alerts.composite_revisions import activate
    from alerts.storage import ChartAlert, MarketComposite
    from test_composite_alerts import config
    from test_switch_activation import rules

    factory, engine = provider_pg
    composite, active, _, ident, _ = contracts.candidate(factory, monkeypatch)
    rule, _ = rules(factory, monkeypatch, composite, active, ident)
    assert rollover.reconcile(composite, budget=16)["status"] == "ready"
    waiting = threading.Event()

    def observed(_conn, _cursor, statement, _params, _context, _many):
        if (threading.current_thread().name.startswith("alert-race")
                and "market_datasets" in statement and "FOR UPDATE" in statement):
            waiting.set()

    event.listen(engine, "before_cursor_execute", observed)

    def operate():
        try:
            with factory.begin() as db:
                db.execute(text("SET LOCAL lock_timeout = '5s'"))
                if operation == "edit":
                    return edit(db, rule, 1, config(composite), at=contracts.STAMP).id
                if operation == "resume":
                    return lifecycle(db, rule, 1, "resume", expected_revision=1,
                                     request_id="concurrent-resume", at=contracts.STAMP).id
                return evaluate(db, rule, now=contracts.STAMP)
        except Conflict:
            return "conflict"

    try:
        with ThreadPoolExecutor(1, thread_name_prefix="alert-race") as pool:
            with factory.begin() as db:
                rollover.lock_scope(db, db.get(MarketComposite, composite))
                future = pool.submit(operate)
                assert waiting.wait(5), "operation must acquire Dataset before ChartAlert"
                # NOWAIT is a deterministic assertion of no inverse alert lock.
                db.scalar(select(ChartAlert).where(ChartAlert.id == rule).with_for_update(nowait=True))
                result = activate(db, composite, ident, {"request_id": "auto:lock-order",
                                  "expected_revision_id": active})
                assert result.revision_id == ident
            value = future.result(timeout=10)
            assert value == ("conflict" if operation != "evaluate" else [])
        with factory() as db:
            assert db.get(MarketComposite, composite).active_revision_id == ident
    finally:
        event.remove(engine, "before_cursor_execute", observed)


def test_fixed_reader_arriving_during_cleanup_is_fenced_and_rejects_trimmed_input(provider_pg, monkeypatch):
    import time

    from alerts import retention_window as window
    from alerts import switch_runs
    from alerts.market_data import renew_demand
    from alerts.storage import Instrument, MarketDemand, Preference
    from test_retention_window import LOWER, NOW, counts, graph, run

    factory, engine = provider_pg
    graph(factory)
    with factory.begin() as db:
        db.add(Preference(key="managed_realtime:TRET", value={"enabled": True}))
    run_id = run(factory)
    switch_runs.claim_retention(run_id, dry_run=False)
    snapshot, release, reader_waiting = threading.Event(), threading.Event(), threading.Event()
    original = window._plan

    def pause_after_reference_snapshot(db, **kwargs):
        result = original(db, **kwargs)
        snapshot.set()
        assert release.wait(5)
        return result

    def observed(_conn, _cursor, statement, _params, _context, _many):
        if (threading.current_thread().name.startswith("fixed-reader")
                and "market_datasets" in statement
                and ("FOR UPDATE" in statement or "FOR SHARE" in statement)):
            reader_waiting.set()

    monkeypatch.setattr(window, "_plan", pause_after_reference_snapshot)
    event.listen(engine, "before_cursor_execute", observed)
    totals = {"rows": 0, "bytes": 0, "deleted": window._zero_deleted(), "blob_scan": {}}

    def clear():
        return window._apply_chunk(run_id=run_id, lower=LOWER, limit=10, now=NOW,
            deadline=int(time.time() * 1000) + 30000, skip_minutes=(), skip_revisions=(), totals=totals)

    def reader():
        with factory.begin() as db:
            db.execute(text("SET LOCAL lock_timeout = '5s'"))
            renew_demand(db, "fixed", db.get(Instrument, "TRET"), composite_revision_id="rev-old")

    try:
        with ThreadPoolExecutor(1) as cleanup, ThreadPoolExecutor(1, thread_name_prefix="fixed-reader") as readers:
            clearing = cleanup.submit(clear)
            try:
                assert snapshot.wait(5)
                reading = readers.submit(reader)
                assert reader_waiting.wait(5), "Core demand upsert must take the revision dataset fence"
            finally:
                release.set()
            assert clearing.result(timeout=10)["deleted"]["market_source_minutes"] == 1
            with pytest.raises(ValueError, match="实时输入已清理"):
                reading.result(timeout=10)
        assert counts(factory)["minutes"] == 0
        with factory() as db:
            assert db.scalar(select(MarketDemand)) is None
    finally:
        event.remove(engine, "before_cursor_execute", observed)


def test_committed_fixed_reader_is_visible_after_cleanup_waits_on_dataset(provider_pg, monkeypatch):
    import time

    from alerts import retention_window as window
    from alerts import switch_runs
    from alerts.market_data import renew_demand
    from alerts.storage import Instrument, Preference
    from test_retention_window import LOWER, NOW, counts, graph, run

    factory, engine = provider_pg
    monkeypatch.setattr("alerts.market_data.now_ms", lambda: NOW)
    graph(factory)
    with factory.begin() as db:
        db.add(Preference(key="managed_realtime:TRET", value={"enabled": True}))
    run_id = run(factory)
    switch_runs.claim_retention(run_id, dry_run=False)
    waiting = threading.Event()

    def observed(_conn, _cursor, statement, _params, _context, _many):
        if (threading.current_thread().name.startswith("cleanup-race")
                and "market_datasets" in statement and "FOR UPDATE" in statement):
            waiting.set()

    def clear():
        totals = {"rows": 0, "bytes": 0, "deleted": window._zero_deleted(), "blob_scan": {}}
        return window._apply_chunk(run_id=run_id, lower=LOWER, limit=10, now=NOW,
            deadline=int(time.time() * 1000) + 30000, skip_minutes=(), skip_revisions=(), totals=totals)

    event.listen(engine, "before_cursor_execute", observed)
    try:
        with ThreadPoolExecutor(1, thread_name_prefix="cleanup-race") as pool:
            with factory.begin() as db:
                renew_demand(db, "fixed", db.get(Instrument, "TRET"), composite_revision_id="rev-old")
                future = pool.submit(clear)
                assert waiting.wait(5)
            report = future.result(timeout=10)
        assert report["deleted"]["market_source_minutes"] == 0
        assert report["summary"]["protected"]["by_reason"]["active_fixed_reader"]
        assert counts(factory)["minutes"] == 1
    finally:
        event.remove(engine, "before_cursor_execute", observed)


def test_repeated_managed_creation_uses_dataset_before_source_lock(provider_pg):
    import test_history_creation_check as creation
    from alerts.history_commands import create_managed
    from alerts.source_registry import collection_identity
    from alerts.storage import MarketDataset, SourceSeries

    factory, engine = provider_pg
    body = {"request_id": "creation-retention-race", "create_only": True,
        "dataset": {k: v for k, v in creation.draft().items() if k != "start_date"},
        "maintenance": {"target_start": 0, "timeframes": ["M1"], "frequency": "once"}}
    with factory.begin() as db:
        first = create_managed(db, body)
        dataset_id = first["dataset"]["id"]
        source_id = collection_identity(db.get(MarketDataset, dataset_id).identity).key
    waiting = threading.Event()

    def observed(_conn, _cursor, statement, _params, _context, _many):
        if (threading.current_thread().name.startswith("creation-race")
                and "market_datasets" in statement and "FOR UPDATE" in statement):
            waiting.set()

    def repeat():
        with factory.begin() as db:
            db.execute(text("SET LOCAL lock_timeout = '5s'"))
            return create_managed(db, body)

    event.listen(engine, "before_cursor_execute", observed)
    try:
        with ThreadPoolExecutor(1, thread_name_prefix="creation-race") as pool:
            with factory.begin() as db:
                db.scalar(select(MarketDataset).where(MarketDataset.id == dataset_id).with_for_update())
                future = pool.submit(repeat)
                assert waiting.wait(5)
                db.scalar(select(SourceSeries).where(SourceSeries.id == source_id).with_for_update(nowait=True))
            assert future.result(timeout=10)["task"]["id"] == first["task"]["id"]
    finally:
        event.remove(engine, "before_cursor_execute", observed)


def test_aggregate_only_cleanup_rejects_new_reader_and_indicator(provider_pg):
    from test_managed_retention import aggregate_only_cleanup

    aggregate_only_cleanup(provider_pg[0])
