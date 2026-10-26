"""Ubuntu isolated PostgreSQL concurrency gates; skips are not acceptance."""

import multiprocessing
import os
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor

import pytest
import test_market_stream as contracts
import test_market_stream_api as http_contracts
import test_market_stream_io_budget as io_contracts
import test_market_stream_quotes as quote_contracts
import test_market_stream_worker as worker_contracts
from alerts import market_stream as stream
from alerts.storage import MarketStreamTask
from indicator_assertions import stable_indicators
from sqlalchemy import func, select
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"),
                               reason="Requires isolated Ubuntu PostgreSQL")


@pytest.mark.parametrize("contract", [
    contracts.test_multiple_pages_share_one_calculation_and_session_scopes_listeners,
    contracts.test_old_cancel_duplicate_register_and_late_register_do_not_remove_new_generation,
    contracts.test_expired_owner_cannot_publish_after_successor,
    contracts.test_result_sequence_rejects_stale_same_bar_and_recovers_or_resets,
    contracts.test_session_end_disables_work_and_output,
    contracts.test_worker_affinity_keeps_current_bucket_owner_until_failure_takeover,
    contracts.test_unconfirmed_previous_minute_retraction_requires_history_restore,
    contracts.test_empty_first_history_receives_status_then_recovery_before_native_bars,
    contracts.test_replay_checks_each_committed_result_without_looking_ahead,
    contracts.test_disconnect_beyond_retained_bar_window_requires_reset,
    contracts.test_indicator_only_change_delivers_native_bar_at_its_own_time,
    contracts.test_idle_lease_and_delivery_do_not_read_retained_history_snapshot,
    contracts.test_slow_consumer_does_not_block_fast_delivery_and_replay_is_bounded,
    contracts.test_composite_history_snapshot_budget_allows_windowed_native_delivery,
    contracts.test_recursive_study_feeds_deliver_only_values_for_accepted_tail_bars,
    contracts.test_external_indicator_prefix_is_consumer_state_not_shared_calculation,
    contracts.test_published_external_prefix_uses_accepted_snapshot_and_preserves_tail,
])
def test_durable_contract(provider_pg, contract):
    # These managed contracts use the same baseline instrument catalogue as
    # the SQLite database fixture. create_all alone leaves this schema empty.
    from alerts import storage

    storage.bootstrap(provider_pg[1])
    contract(provider_pg[0])


@pytest.mark.parametrize("cached_inputs", [False, True])
def test_published_indicator_prefix_proof_matches_inputs_during_concurrent_repair(
    provider_pg, monkeypatch, cached_inputs
):
    from types import SimpleNamespace

    from alerts import managed_dataset, managed_indicator_inputs
    from alerts.chart_query import DataQuery
    from alerts.storage import ChartPublication, ChartPublishedBar, Instrument

    factory, _ = provider_pg
    with factory.begin() as db:
        db.add(Instrument(id="PREFIX_TEST", label="Prefix test", source="binance", symbol="PREFIX_TEST",
            basis="trade", calendar="utc0", precision=2, enabled=False, calendar_profile={}))
        db.flush()
        db.add(ChartPublication(instrument_id="PREFIX_TEST", timeframe="M1", start=60000,
            end=360000, complete_count=5, initialized=True, revision=1))
        for start in (60000, 120000, 180000, 240000, 300000):
            payload = dict(start=start, end=start+60000, open="10", high="11", low="9",
                           close="10", complete=True, volume=None)
            db.add(ChartPublishedBar(instrument_id="PREFIX_TEST", timeframe="M1", start=start,
                end=start+60000, complete=True, payload=payload, revision=1))
    query = DataQuery(instrument="PREFIX_TEST", series_kind="managed", timeframe="M1", published=True,
        dataset_start=60000, before=360000, limit=2, dependency_before=240000,
        indicators=[{"name": "EMA", "params": {"period": 2}}])
    before = managed_dataset.data(query)
    freeze = managed_indicator_inputs.freeze
    if not cached_inputs:
        monkeypatch.setattr(managed_indicator_inputs, "_INPUTS", OrderedDict())
    repairs = []

    def repair_after_input_read(*args, **kwargs):
        frozen, execution = freeze(*args, **kwargs)
        assert execution["input_cache"] == ("hit" if cached_inputs else "miss")
        if not repairs:
            # Commit on a second PostgreSQL connection after the reader accepts
            # its inputs, before it reads the dependency fingerprint.
            with factory.begin() as db:
                row = db.get(ChartPublishedBar, ("PREFIX_TEST", "M1", 120000))
                row.payload = {**row.payload, "high": "101", "close": "100"}
                row.revision += 1
                db.get(ChartPublication, ("PREFIX_TEST", "M1")).revision += 1
            repairs.append(True)
        return frozen, execution

    monkeypatch.setattr(managed_indicator_inputs, "freeze", repair_after_input_read)
    accepted = managed_dataset.data(query)
    monkeypatch.setattr(managed_indicator_inputs, "freeze", freeze)
    current = managed_dataset.data(query)
    assert repairs == [True]
    assert stable_indicators(accepted) == stable_indicators(before), \
        "accepted values retain their old input snapshot"
    assert accepted["dependency_revision"] == before["dependency_revision"], \
        "the prefix proof must describe those same inputs, not the concurrent repair"
    assert current["dependency_revision"] != accepted["dependency_revision"]
    assert current["indicators"][0]["series"] != accepted["indicators"][0]["series"]
    state = dict(history_accepted=True, historical=True, loaded_before=300000, loaded_after=240000,
        dependency_origin=60000, dependency_before=240000, dependency_revision=accepted["dependency_revision"],
        cursor=300000)
    task = SimpleNamespace(query=query.model_copy(update={"indicators": []}).model_dump(), identity={})
    sub = SimpleNamespace(listener="external", generation=1, state=state)
    with factory.begin() as db:
        event = stream.delivery(db, task, sub, {"type": "bars", "bars": [{"start": 300000}]}, {})
    assert event["indicator_correction"], "the first subscription delivery must detect the intervening repair"
    assert event["dependency_revision"] == current["dependency_revision"]


def test_concurrent_clients_and_workers_share_one_task_and_one_claim(provider_pg):
    factory, _ = provider_pg
    owner = contracts.session(factory)
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda i: contracts.register(owner, client="page" + str(i)), range(8)))
    assert len({row["task_id"] for row in results}) == 1
    with factory.begin() as db:
        assert db.scalar(select(func.count()).select_from(MarketStreamTask)) == 1
    with ThreadPoolExecutor(max_workers=4) as pool:
        claims = [work for work in pool.map(lambda i: stream.claim(owner="worker" + str(i)), range(4)) if work]
    assert len(claims) == 1
    stream.commit(claims[0], {"type": "status", "status": "ready"})


@pytest.mark.parametrize("contract", [
    worker_contracts.test_shared_worker_detects_history_only_correction_and_consumers_have_distinct_windows,
    worker_contracts.test_current_bucket_reader_uses_delta_and_replaces_expired_stream_observation,
    worker_contracts.test_shared_page_cache_matches_authoritative_high_period_overlay,
    worker_contracts.test_live_quote_arriving_during_chart_resolution_is_not_retracted,
    worker_contracts.test_canceling_last_browser_demand_preserves_other_internal_owners,
    worker_contracts.test_canceled_inflight_computation_does_not_leave_a_browser_demand,
    worker_contracts.test_indicator_initialization_is_shared_and_completion_requests_history_recovery,
    worker_contracts.test_correction_to_previously_streamed_bar_requires_native_history_reset,
    worker_contracts.test_historical_window_credentials_do_not_expand_to_realtime_tail,
    worker_contracts.test_external_composite_prefix_correction_preserves_shared_main_task,
])
def test_worker_contract_postgres(provider_pg, monkeypatch, contract):
    contract(provider_pg[0], monkeypatch)


@pytest.mark.parametrize("contract", [
    quote_contracts.test_quote_only_clients_share_work_and_report_expiry_without_new_price,
    quote_contracts.test_fixed_quote_input_remains_on_accepted_confirmation,
    quote_contracts.test_follow_active_switch_releases_only_previous_task_revision_demand,
    quote_contracts.test_quote_only_provider_task_keeps_supplier_cadence_without_history_interest,
    quote_contracts.test_replacing_last_quote_consumer_retires_previous_series_demand,
    quote_contracts.test_replacement_retains_demand_for_another_page_and_late_cancel_is_fenced,
    quote_contracts.test_cancel_after_active_switch_before_worker_runs_retires_previous_demand,
    quote_contracts.test_explicit_quote_revision_does_not_follow_active_switch,
])
def test_quote_contract_postgres(provider_pg, monkeypatch, contract):
    from alerts import storage

    storage.bootstrap(provider_pg[1])
    contract(provider_pg[0], monkeypatch)


@pytest.mark.parametrize("contract", [
    http_contracts.test_http_authentication_csrf_and_same_client_name_do_not_cross_sessions,
    http_contracts.test_registration_cannot_mutate_fixed_identity_in_the_same_generation,
    worker_contracts.test_managed_preparation_waits_for_native_dataset_readiness,
    worker_contracts.test_published_stream_signal_uses_publication_evidence_without_scanning_staging_history,
    quote_contracts.test_managed_quote_cancellation_releases_only_task_demand,
    quote_contracts.test_managed_quotes_with_history_plan_deliver_confirmed_updates,
])
def test_managed_and_http_contract_postgres(provider_pg, contract):
    from alerts import storage

    storage.bootstrap(provider_pg[1])
    contract(provider_pg[0])


def test_binding_retirement_postgres(provider_pg,monkeypatch):
    contracts.test_repeated_binding_retirement_cleans_only_expired_task_resources(provider_pg[0],monkeypatch)


def test_idle_delivery_io_postgres(provider_pg):
    from alerts import storage

    storage.bootstrap(provider_pg[1])
    io_contracts.test_idle_connection_does_not_rewrite_all_leases_each_delivery_poll(provider_pg[0])


def test_new_registration_keeps_old_lease_postgres(provider_pg, monkeypatch):
    from alerts import storage

    storage.bootstrap(provider_pg[1])
    io_contracts.test_registering_new_listeners_does_not_starve_existing_lease(provider_pg[0], monkeypatch)


def process_operation(args):
    """Spawned processes have independent engines and no inherited pool state."""
    from alerts import storage
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    url, schema, operation, owner, number = args
    engine = create_engine(url, connect_args={"options": f"-csearch_path={schema}"},
                           pool_size=1, max_overflow=0)
    storage.Session = sessionmaker(engine, expire_on_commit=False)
    try:
        if operation == "register":
            return contracts.register(owner, client="process-page-" + str(number))
        return stream.claim(owner="process-worker-" + str(number))
    finally:
        engine.dispose()


def test_separate_api_and_worker_processes_share_one_task_and_claim(provider_pg):
    from sqlalchemy import text

    factory, engine = provider_pg
    owner = contracts.session(factory)
    with engine.connect() as connection:
        schema = connection.scalar(text("SELECT current_schema()"))
    assert schema.startswith("provider_")
    url = engine.url.render_as_string(hide_password=False)
    with multiprocessing.get_context("spawn").Pool(4) as pool:
        registrations = pool.map(process_operation, [
            (url, schema, "register", owner, number) for number in range(8)])
        assert len({row["task_id"] for row in registrations}) == 1
        claims = [work for work in pool.map(process_operation, [
            (url, schema, "claim", owner, number) for number in range(4)]) if work]
    assert len(claims) == 1, "independent worker processes must acquire one shared calculation"
    stream.commit(claims[0], {"type": "bars", "bars": [{"start": 60000}]})
    events = [stream.events(owner, "process-page-" + str(number), {}) for number in range(8)]
    assert all(len(rows) == 1 and rows[0]["bars"][0]["start"] == 60000 for rows in events)
