"""Actual PostgreSQL fixed strategy transactions, concurrency and migration."""

import importlib.util
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
import test_composite_watches as contracts
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alerts.composite_watches import evaluate
from alerts.storage import (
    CompositeWatchBinding,
    CompositeWatchJudgment,
    Notification,
    Outbox,
    SignalRow,
    Watch,
)
from sqlalchemy import func, inspect, select
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated Ubuntu PostgreSQL")


@pytest.mark.parametrize("contract", [
    contracts.test_fixed_binding_one_event_and_durable_demand,
    contracts.test_recovery_and_correction_never_replay_cross,
    contracts.test_chart_activation_cannot_move_existing_strategy,
    contracts.test_interface_keeps_legacy_rule_schema_and_fixed_input_immutable,
    contracts.test_sma_uses_fixed_history_and_exact_declared_windows,
    contracts.test_pullback_readiness_survives_beyond_any_short_lookback,
    contracts.test_missing_previous_daily_context_is_never_replaced_by_an_older_day,
    contracts.test_sampled_price_requires_quote_epoch_and_baselines_recovery,
    contracts.test_full_origin_warmup_is_batched_and_keeps_checkpoint,
    contracts.test_previous_day_uses_exact_fixed_daily_artifact_and_triggers,
    contracts.test_missed_events_and_mutated_rules_cannot_emit,
    contracts.test_repeated_logical_event_after_state_rewind_keeps_outbox_single,
    contracts.test_cancelled_watch_keeps_fixed_history_reference,
    contracts.test_fixed_strategy_only_demands_old_mapping_until_a_chart_opens,
    contracts.test_no_history_setting_waits_for_post_creation_baseline,
    contracts.test_explicit_revision_captures_existing_watch_indicator_preparation,
])
def test_contract(provider_pg, monkeypatch, contract):
    contract(provider_pg[0], monkeypatch)


def test_rollback_and_concurrent_evaluation_emit_one_event(provider_pg, monkeypatch):
    factory, _ = provider_pg
    ident, _, revision, seam, stamp = contracts.armed(factory, monkeypatch)
    with factory.begin() as db:
        evaluate(db, ident, now=stamp)
    contracts.append(factory, revision, seam + 600000, "1.119", seam + 660010)
    with pytest.raises(RuntimeError, match="rollback"):
        with factory.begin() as db:
            assert evaluate(db, ident, now=seam + 660010)
            raise RuntimeError("rollback")
    with factory.begin() as db:
        assert db.get(Watch, ident).status == "active"
        assert db.scalar(select(SignalRow)) is None
    def run(_):
        with factory.begin() as db:
            return bool(evaluate(db, ident, now=seam + 660010))
    with ThreadPoolExecutor(max_workers=4) as executor:
        assert sum(executor.map(run, range(8))) == 1
    with factory.begin() as db:
        for model in (SignalRow, Notification, Outbox):
            assert db.scalar(select(func.count()).select_from(model)) == 1


def test_additive_migration_and_downgrade_guard(provider_pg, monkeypatch):
    factory, engine = provider_pg
    _, composite, _, _, stamp = contracts.armed(factory, monkeypatch)
    path = Path(__file__).resolve().parents[2] / "migrations/versions/ak38_composite_watch_bindings.py"
    spec = importlib.util.spec_from_file_location("watch_bindings", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    with engine.begin() as connection:
        CompositeWatchJudgment.__table__.drop(connection)
        CompositeWatchBinding.__table__.drop(connection)
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        assert "market_composite_watch_bindings" in inspect(connection).get_table_names()
    with factory.begin() as db:
        ident = contracts.create(db, composite, "迁移后策略", {"kind": "price", "timeframe": "M1", "level": "1.115"}, armed_at=stamp).id
        assert evaluate(db, ident, now=stamp) is None
        assert db.get(CompositeWatchBinding, ident).health == "ready"
    with engine.begin() as connection:
        migration.op = Operations(MigrationContext.configure(connection))
        with pytest.raises(RuntimeError, match="backup"):
            migration.downgrade()
