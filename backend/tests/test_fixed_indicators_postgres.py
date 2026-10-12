"""Real isolated PostgreSQL indicator state, immutable repair and fencing."""

import importlib.util
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
import test_fixed_indicators as contracts
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alerts import fixed_indicators as jobs
from alerts.chart_api import DataQuery, data_sync
from alerts.storage import FixedIndicatorBlock, FixedIndicatorRun
from sqlalchemy import inspect
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated Ubuntu PostgreSQL")


@pytest.mark.parametrize("contract", [
    contracts.test_historical_page_reads_full_origin_and_persisted_outputs_without_m1,
    contracts.test_bounded_progress_fences_stale_owners_and_recovers_from_checkpoint,
    contracts.test_missing_aggregate_waterline_waits_without_publishing_or_advancing,
    contracts.test_failed_build_preserves_cursor_and_retries,
    contracts.test_recursive_history_review_includes_dependencies_before_visible_price_range,
    contracts.test_completed_indicator_cache_does_not_prevent_unreferenced_history_reclamation,
    contracts.test_indicator_csv_pending_commits_request_and_ready_exports_all_pages,
    contracts.test_seam_inside_evidenced_closure_still_marks_recursive_cross_source_dependency,
    contracts.test_provisional_chart_value_never_advances_durable_confirmed_state,
    contracts.test_worker_never_reinterprets_pending_state_from_an_older_algorithm,
])
def test_indicator_contract(provider_pg, monkeypatch, contract):
    contract(provider_pg[0], monkeypatch)


@pytest.mark.parametrize("spec", [
    {"name": "EMA", "params": {"period": 2}},
    {"name": "SUPERTREND_PINE_V1", "params": {"period": 2, "multiplier": 0.1}},
])
def test_append_and_repair(provider_pg, monkeypatch, spec):
    contracts.test_composite_append_reuses_prefix_correction_repairs_suffix_and_old_input_remains(
        provider_pg[0], monkeypatch, spec)


def test_concurrent_first_requests_and_workers_share_one_run_and_owner(provider_pg, monkeypatch):
    version = contracts.history(provider_pg[0], monkeypatch, count=70)
    def first(_):
        return data_sync(DataQuery(instrument=version, series_kind="history", timeframe="M1", limit=2,
                                  indicators=[contracts.SPEC]))["indicator_progress"][0]["run_id"]
    with ThreadPoolExecutor(max_workers=2) as pool:
        ids = list(pool.map(first, range(4)))
    assert len(set(ids)) == 1
    with ThreadPoolExecutor(max_workers=2) as pool:
        owners = [owner for owner in pool.map(lambda _: jobs.claim(ids[0]), range(2)) if owner]
    assert len(owners) == 1
    jobs.commit(owners[0], jobs.build(owners[0]))
    with pytest.raises(TimeoutError):
        jobs.commit(owners[0], jobs.build(owners[0]))


def test_additive_migration_and_downgrade_snapshot_protection(provider_pg, monkeypatch):
    factory, engine = provider_pg
    path = Path(__file__).resolve().parents[2] / "migrations/versions/ah35_fixed_indicators.py"
    spec = importlib.util.spec_from_file_location("fixed_indicator_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    with engine.begin() as conn:
        FixedIndicatorBlock.__table__.drop(conn)
        FixedIndicatorRun.__table__.drop(conn)
        migration.op = Operations(MigrationContext.configure(conn))
        migration.upgrade()
        assert "market_fixed_indicator_blocks" in inspect(conn).get_table_names()
    version = contracts.history(factory, monkeypatch, count=70)
    data_sync(DataQuery(instrument=version, series_kind="history", timeframe="M1", limit=2, indicators=[contracts.SPEC]))
    with engine.begin() as conn:
        migration.op = Operations(MigrationContext.configure(conn))
        with pytest.raises(RuntimeError, match="backup"):
            migration.downgrade()
