"""ATR input/checkpoint contracts on actual isolated PostgreSQL, including contention."""

import os
from concurrent.futures import ThreadPoolExecutor

import pytest
import test_chart_alert_offsets as contracts
from alerts.chart_alert_service import create
from alerts.chart_alert_worker import evaluate
from alerts.storage import ChartAlert, Notification, Outbox, SignalRow, bootstrap
from sqlalchemy import func, select
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated Ubuntu PostgreSQL")


@pytest.fixture(autouse=True)
def seeded_instruments(provider_pg):
    bootstrap(provider_pg[1])


@pytest.mark.parametrize("contract", [
    contracts.test_legacy_null_config_keeps_original_hash_and_request_replay,
    contracts.test_worker_uses_previous_atr_and_persists_atomic_checkpoint,
    contracts.test_transaction_rollback_does_not_double_translate_or_deliver,
    contracts.test_atr_revision_is_blocked_and_original_evidence_stays_immutable,
    contracts.test_consume_rebase_retry_and_downward_precision,
    contracts.test_smaller_atr_timeframe_is_fixed_through_evaluation_bucket,
    contracts.test_missing_latest_atr_waits_then_recovers_without_gap_signal,
    contracts.test_h4_d1_shared_close_uses_old_day_then_rebases_on_first_new_price,
    contracts.test_independent_atr_revision_blocks_while_main_input_is_unchanged,
    contracts.test_provider_second_frame_polled_shared_and_protected_without_browser,
])
def test_postgres_atr_contract(provider_pg, contract, monkeypatch):
    if contract == contracts.test_provider_second_frame_polled_shared_and_protected_without_browser:
        contract(provider_pg[0], monkeypatch)
    else:
        contract(provider_pg[0])


def test_postgres_atr_composite_contract(provider_pg, monkeypatch):
    contracts.test_composite_atr_uses_fixed_revision_and_real_transaction(provider_pg[0], monkeypatch)


def test_postgres_composite_cross_frame_contract(provider_pg, monkeypatch):
    contracts.test_composite_cross_frame_atr_watermark_seam_and_price_correction(provider_pg[0], monkeypatch)


@pytest.mark.parametrize("kind", ["provider", "published"])
def test_postgres_atr_volume_contract(provider_pg, kind):
    contracts.test_atr_volume_refresh_does_not_block_but_price_revision_does(provider_pg[0], kind)


@pytest.mark.parametrize("published", [False, True])
def test_postgres_atr_paging_contract(provider_pg, monkeypatch, published):
    contracts.test_atr_forward_initialization_persists_fixed_origin_across_bounded_pages(provider_pg[0], monkeypatch, published)


def test_concurrent_refresh_consumes_difference_and_event_once(provider_pg):
    database = provider_pg[0]
    with database.begin() as db:
        contracts.seed(db, [(100, 4), (100, 4), (100, 4), (101, 2), (104, 2)])
        ident = create(db, "atr-pg-concurrent", contracts.config(notify_ntfy=True), at=180000).id
        assert evaluate(db, ident, now=240001) == []

    def attempt(_):
        with database.begin() as db:
            return evaluate(db, ident, now=300001)

    with ThreadPoolExecutor(max_workers=4) as executor:
        events = list(executor.map(attempt, range(8)))
    assert sum(len(value) for value in events) == 1
    with database() as db:
        row = db.get(ChartAlert, ident)
        assert row.count == 1
        assert row.runtime["offset"]["signed_offset"] == "1.50"
        assert db.scalar(select(func.count()).select_from(SignalRow)) == 1
        assert db.scalar(select(func.count()).select_from(Notification)) == 1
        assert db.scalar(select(func.count()).select_from(Outbox)) == 1


def test_postgres_intrabar_confirmed_at_contract(provider_pg):
    contracts.test_intrabar_h4_d1_reference_stays_fixed_and_delayed_confirmation_recovers(provider_pg[0])


@pytest.mark.parametrize("policy", ["reject", "accept_raw"])
def test_postgres_continuous_seam_policy(provider_pg, monkeypatch, policy):
    contracts.test_composite_cross_frame_atr_continuous_seam_policy(provider_pg[0], monkeypatch, policy)


def test_postgres_provider_first_confirmation(provider_pg):
    contracts.test_unchanged_provider_overlap_does_not_rewrite_first_price_confirmation(provider_pg[0])


def test_postgres_ny17_weekend_confirmation(provider_pg):
    contracts.test_managed_ny17_dst_weekend_uses_confirmed_friday_atr(provider_pg[0])
