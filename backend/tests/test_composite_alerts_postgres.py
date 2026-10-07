"""Actual isolated PostgreSQL fixed-rule publication, recovery and concurrency."""

import importlib.util
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
import test_composite_alerts as contracts
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alerts.chart_alert_worker import evaluate
from alerts.storage import ChartAlert, CompositeJudgment, Notification, Outbox, SignalRow
from sqlalchemy import func, inspect, select
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated Ubuntu PostgreSQL")


@pytest.mark.parametrize("contract", [
    contracts.test_fixed_binding_persistent_demand_and_one_transactional_event,
    contracts.test_disconnect_recovery_baselines_old_cross_and_later_new_event_triggers,
    contracts.test_correction_rebuild_preserves_judgments_and_never_replays_historical_event,
    contracts.test_missing_confirmation_period_waterline_and_stale_owner_all_fence_rules,
    contracts.test_complete_recursive_initialization_requires_explicit_raw_seam_policy,
    contracts.test_seam_jump_itself_never_compares_prices_or_accepted_indicators,
    contracts.test_indicator_dependency_gap_cannot_be_hidden_by_latest_confirmed_minute,
    contracts.test_normal_async_indicator_append_keeps_comparison_state_and_triggers_new_cross,
    contracts.test_explicit_sampled_quote_mode_never_mutates_confirmed_state_and_requires_valid_owner,
    contracts.test_missed_and_expired_events_establish_baseline_without_notifications,
    contracts.test_duplicate_logical_event_after_state_recovery_keeps_count,
    contracts.test_active_chart_revision_switch_never_retargets_running_rule,
    contracts.test_pure_capabilities_and_authenticated_fixed_creation_geometry_judgments,
])
def test_composite_rule_contract(provider_pg, monkeypatch, contract):
    contract(provider_pg[0], monkeypatch)


@pytest.mark.parametrize("gap", [15000, 15001, 30000])
def test_intrabar_quote_gap(provider_pg, monkeypatch, gap):
    contracts.test_intrabar_quote_gap_without_worker_stale_check_rebuilds_baseline(provider_pg[0], monkeypatch, gap)


def test_competing_evaluators_and_rollback_preserve_single_event(provider_pg, monkeypatch):
    factory, _ = provider_pg
    ident, _, revision, seam, stamp = contracts.armed(factory, monkeypatch, notify_ntfy=True)
    with factory.begin() as db:
        evaluate(db, ident, now=stamp)
    now = seam + 660010
    contracts.append(factory, revision, seam + 600000, "1.119", now)
    with pytest.raises(RuntimeError):
        with factory.begin() as db:
            assert len(evaluate(db, ident, now=now)) == 1
            raise RuntimeError("rollback signal and state")
    with factory.begin() as db:
        assert db.get(ChartAlert, ident).count == 0
        assert db.scalar(select(SignalRow)) is None
    def run(_):
        with factory.begin() as db:
            return evaluate(db, ident, now=now)
    with ThreadPoolExecutor(max_workers=2) as pool:
        events = list(pool.map(run, range(4)))
    assert sum(len(result) for result in events) == 1
    with factory.begin() as db:
        for model in (SignalRow, Notification, Outbox):
            assert db.scalar(select(func.count()).select_from(model)) == 1


def test_additive_judgment_migration_preserves_rules_and_rejects_downgrade(provider_pg, monkeypatch):
    factory, engine = provider_pg
    ident, _, _, _, stamp = contracts.armed(factory, monkeypatch)
    path = Path(__file__).resolve().parents[2] / "migrations/versions/ai36_composite_alerts.py"
    spec = importlib.util.spec_from_file_location("composite_alert_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    with engine.begin() as conn:
        CompositeJudgment.__table__.drop(conn)
        migration.op = Operations(MigrationContext.configure(conn))
        migration.upgrade()
        assert "market_composite_judgments" in inspect(conn).get_table_names()
    with factory.begin() as db:
        evaluate(db, ident, now=stamp)
        assert db.scalar(select(CompositeJudgment))
    with engine.begin() as conn:
        migration.op = Operations(MigrationContext.configure(conn))
        with pytest.raises(RuntimeError, match="backup"):
            migration.downgrade()
