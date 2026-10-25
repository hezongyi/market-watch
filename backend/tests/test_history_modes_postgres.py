"""Run managed period contracts on task-owned PostgreSQL 14.24 after approval."""

import os

import pytest
import test_native_history_archive as contracts
import test_native_history_retention as retention
from sqlalchemy import text
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"),
                               reason="Requires task-owned Ubuntu PostgreSQL 14.24")


@pytest.mark.parametrize("contract", [
    contracts.test_d1_cross_year_week_month_sparse_input_and_fixed_indicator_without_m1,
    contracts.test_native_periods_have_independent_windows_and_never_derive_native_week,
    contracts.test_rolling_window_keeps_old_rows_and_revision_preserves_old_snapshot,
    contracts.test_one_period_timeout_publishes_partial_and_keeps_previous_period,
    contracts.test_first_failed_period_unavailable_all_failure_never_advances_good_version,
    contracts.test_cancel_during_io_discards_response_and_frame_cursor,
    contracts.test_partial_retry_is_new_version_and_requests_only_failed_frame,
    contracts.test_expired_owner_response_cannot_overwrite_replacement_checkpoint,
    contracts.test_only_due_frame_runs_and_schedule_revision_ignores_progress,
    contracts.test_all_failed_retry_restores_active_task_and_can_publish,
    contracts.test_native_update_rechecks_available_window_not_only_last_two_bars,
    contracts.test_frame_target_can_precede_top_level_and_explicit_backfill_keeps_requested_bounds,
    retention.test_reclaim_removes_native_pages_but_protects_another_checkpoint,
    retention.test_saved_native_indicator_chart_protects_fixed_version_after_cache_cleanup,
], ids=lambda contract: contract.__name__)
def test_postgres_period_contract(provider_pg, contract):
    factory, engine = provider_pg
    with engine.connect() as connection:
        assert connection.scalar(text("SHOW server_version_num")) == "140024"
    contract(factory)


@pytest.mark.parametrize("adjustment", ["none", "qfq", "hfq"])
def test_postgres_remote_daily_revision(provider_pg, adjustment):
    contracts.test_daily_refresh_detects_remote_revision_outside_recent_overlap(provider_pg[0], adjustment)


@pytest.mark.parametrize("previous_rows, expected", [(False, "unavailable"), (True, "stale")])
def test_postgres_inherited_failed_period(provider_pg, previous_rows, expected):
    contracts.test_not_due_failed_frame_keeps_freshness_and_does_not_block_completion(
        provider_pg[0], previous_rows, expected)


def test_postgres_pre_modes_migration_keeps_m1_payload(provider_pg):
    import gzip
    import hashlib

    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    from alerts.storage import Instrument, MarketDataset
    from test_history_modes_migration import upgrade

    _, engine = provider_pg
    content = gzip.compress(b'[{"timestamp":0,"close":"1.1"}]', mtime=0)
    checksum = hashlib.sha256(content).hexdigest()
    with engine.begin() as connection:
        # Recreate the deployed legacy columns before applying the real revision.
        with Operations.context(MigrationContext.configure(connection)) as operations:
            operations.drop_table("market_history_frame_runs")
            operations.drop_table("market_dataset_frame_sources")
            operations.drop_constraint("uq_history_chunk_version_frame_start", "market_history_chunks", type_="unique")
            operations.drop_column("market_history_chunks", "timeframe")
            operations.create_unique_constraint("legacy_chunk_unique", "market_history_chunks", ["version_id", "start"])
            operations.drop_column("market_history_read_attempts", "timeframe")
            operations.drop_column("market_dataset_maintenance", "frame_plan")
        connection.execute(Instrument.__table__.insert().values(id="migration-history", label="kept",
            symbol="EURUSD", source="dukascopy", calendar="ny17", precision=5, basis="bid", enabled=False))
        connection.execute(MarketDataset.__table__.insert().values(id="legacy-dataset",
            instrument_id="migration-history", logical_symbol="EURUSD", identity={},
            volume_kind="unavailable", asset_class="forex"))
        connection.execute(text("INSERT INTO market_history_versions "
            "(id,dataset_id,start,\"end\",cursor,status,manifest,created_at,updated_at,lease_until,attempts,next_at) "
            "VALUES ('legacy-version','legacy-dataset',0,60000,60000,'published','{\"checksum\":\"unchanged\"}',1,1,0,0,0)"))
        connection.execute(text("INSERT INTO market_history_chunks "
            "(id,version_id,start,\"end\",observed_at,count,checksum,content,result,unknown) "
            "VALUES ('legacy-chunk','legacy-version',0,60000,1,1,:digest,:content,'data','[]')"),
            {"digest": checksum, "content": content})
        before = connection.execute(text("SELECT id,version_id,start,\"end\",checksum,content FROM market_history_chunks")).all()
        migration = upgrade(connection)
        assert connection.execute(text("SELECT id,version_id,start,\"end\",checksum,content FROM market_history_chunks")).all() == before
        assert connection.scalar(text("SELECT timeframe FROM market_history_chunks")) == "M1"
        assert connection.scalar(text("SELECT COUNT(*) FROM market_history_frame_runs")) == 0
        upgrade(connection)
        with pytest.raises(RuntimeError, match="Retain archived"):
            migration.downgrade()
