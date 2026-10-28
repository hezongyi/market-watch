"""Actual PostgreSQL group exclusion and conditional per-boot health writes."""

import copy
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal

import pytest
import test_composite_alerts as composite_contracts
from alerts import (
    fixed_indicators,
    market_runtime,
    runtime_health,
)
from alerts.chart_indicators import calculate
from alerts.composite_chart import chart_page
from alerts.runtime_supervisor import Loop, RuntimeGroupError, run_group
from alerts.storage import (
    ChartAlert,
    CompositeAggregateTask,
    CompositePreparation,
    FixedIndicatorBlock,
    FixedIndicatorRun,
    Preference,
    SignalRow,
    transaction,
)
from sqlalchemy import create_engine, delete, event, func, select, text
from sqlalchemy.orm import sessionmaker
from test_fixed_indicators import add_tail, drain
from test_market_contracts import minute
from test_provider_postgres import provider_pg as _provider_pg
from test_runtime_observation_race import (
    test_new_cross_committed_after_clock_capture_is_not_lost as race_contract,
)

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"),
                                reason="Requires isolated Ubuntu PostgreSQL")


@pytest.mark.parametrize("contract", ["aggregate_backoff", "realtime_collection", "error_fencing"])
def test_role_health_with_real_postgres(provider_pg, monkeypatch, contract):
    from test_market_runtime import (
        test_aggregate_success_cannot_clear_other_period_in_backoff,
        test_failed_old_alert_turn_cannot_overwrite_replacement_health,
    )
    from test_realtime_worker import (
        test_handled_collection_fault_stays_visible_until_its_source_recovers,
    )

    selected = {
        "aggregate_backoff": test_aggregate_success_cannot_clear_other_period_in_backoff,
        "realtime_collection": test_handled_collection_fault_stays_visible_until_its_source_recovers,
        "error_fencing": test_failed_old_alert_turn_cannot_overwrite_replacement_health,
    }
    if contract == "realtime_collection":
        from alerts.storage import bootstrap

        bootstrap(provider_pg[1])
    selected[contract](provider_pg[0], monkeypatch)


@pytest.mark.parametrize("status", ["timeout", "rate_limited", "unavailable"])
def test_confirmation_health_with_real_postgres(provider_pg, monkeypatch, status):
    from test_live_pricing import running
    from test_runtime_confirmation_health import (
        test_confirmation_error_survives_backoff_peer_success_and_quotes,
    )

    prepared = running.__wrapped__(provider_pg[0], monkeypatch)
    test_confirmation_error_survives_backoff_peer_success_and_quotes(prepared, monkeypatch, status)


def test_market_group_exclusion_is_released_after_shutdown(provider_pg):
    _, engine = provider_pg
    with market_runtime.ownership(engine):
        with pytest.raises(RuntimeError, match="Another market-runtime"):
            with market_runtime.ownership(engine):
                raise AssertionError("competing scheduler started")
    with market_runtime.ownership(engine):
        pass


def test_chart_alert_owner_is_exclusive_across_market_and_independent_profiles(provider_pg):
    _, engine = provider_pg
    with market_runtime.chart_alert_ownership(engine):
        with pytest.raises(RuntimeError, match="Another ChartAlert runtime"):
            with market_runtime.chart_alert_ownership(engine):
                raise AssertionError("competing ChartAlert scheduler started")
    with market_runtime.chart_alert_ownership(engine):
        pass


def test_rejected_market_start_preserves_existing_alert_boot_and_judgment(provider_pg, monkeypatch):
    factory, _ = provider_pg
    from alerts import storage

    ident, _, revision, seam, stamp = composite_contracts.armed(factory, monkeypatch)
    with factory() as db:
        schema = db.scalar(text("SELECT current_schema()"))
    url = factory.kw["bind"].url.update_query_dict({"options": f"-csearch_path={schema}"})
    monkeypatch.setattr("alerts.config.settings.database_pool_size", 8)
    engine = storage.make_engine(url.render_as_string(hide_password=False))
    monkeypatch.setattr(storage, "engine", engine)
    monkeypatch.setattr(storage, "bootstrap", lambda: None)
    monkeypatch.setattr("alerts.config.settings.oanda_native_latest_owner", "provider")
    monkeypatch.setattr("alerts.provider_transport.close_clients", lambda: None)
    owner = runtime_health.Progress("market", "chart_alert", "existing-alert")
    try:
        with market_runtime.chart_alert_ownership(engine):
            owner.claim()
            owner.record()
            with factory() as db:
                before = copy.deepcopy(db.get(Preference, runtime_health.key("chart_alert")).value)
            with pytest.raises(RuntimeError, match="Another ChartAlert runtime"):
                market_runtime.run(loops=[Loop("chart_alert", lambda stop: stop.wait())],
                                   handle_signals=False)
            with factory() as db:
                assert db.get(Preference, runtime_health.key("chart_alert")).value == before
            with runtime_health.reporting(owner), factory.begin() as db:
                runtime_health.assert_current(db)
                assert composite_contracts.evaluate(db, ident, now=stamp) == []
            now = seam + 660010
            composite_contracts.append(factory, revision, seam + 600000, "1.119", now)
            with runtime_health.reporting(owner), factory.begin() as db:
                runtime_health.assert_current(db)
                assert len(composite_contracts.evaluate(db, ident, now=now)) == 1
                assert db.get(ChartAlert, ident).count == 1
    finally:
        engine.dispose()


@pytest.mark.parametrize("profile", ["market", "alert"])
def test_unstopped_runtime_exits_before_releasing_ownership(provider_pg, monkeypatch, profile):
    factory, _ = provider_pg
    from alerts import alert_runtime, runtime, storage

    with factory() as db:
        schema = db.scalar(text("SELECT current_schema()"))
    url = factory.kw["bind"].url.update_query_dict({"options": f"-csearch_path={schema}"})
    monkeypatch.setattr("alerts.config.settings.database_pool_size", 8)
    engine = storage.make_engine(url.render_as_string(hide_password=False))
    monkeypatch.setattr(storage, "engine", engine)
    monkeypatch.setattr(storage, "bootstrap", lambda: None)
    monkeypatch.setattr("alerts.config.settings.oanda_native_latest_owner", "provider")
    monkeypatch.setattr("alerts.config.settings.market_runtime_chart_alert_enabled", True)
    monkeypatch.setattr("alerts.provider_transport.close_clients",
                        lambda: pytest.fail("clients closed while threads still run"))
    monkeypatch.setattr("sys.argv", ["runtime", "--profile", profile])
    monkeypatch.setattr("logging.shutdown", lambda: None)

    def still_running(*_args, **_kwargs):
        raise RuntimeGroupError({}, alive=("nested-confirmation",))

    monkeypatch.setattr(market_runtime if profile == "market" else alert_runtime,
                        "run_group", still_running)

    class ProcessExit(BaseException):
        pass

    def exit_while_locked(code):
        assert code == 1
        with pytest.raises(RuntimeError, match="Another ChartAlert runtime"):
            with market_runtime.chart_alert_ownership(engine):
                pytest.fail("old alert threads still running after lock released")
        if profile == "market":
            with pytest.raises(RuntimeError, match="Another market-runtime"):
                with market_runtime.ownership(engine):
                    pytest.fail("old market threads still running after lock released")
        raise ProcessExit()

    monkeypatch.setattr("os._exit", exit_while_locked)
    try:
        with pytest.raises(ProcessExit):
            runtime.main()
    finally:
        engine.dispose()


@pytest.mark.parametrize("minutes", [1, 8, 9])
def test_runtime_indicator_claim_leaves_initialization_and_long_repairs_to_data(provider_pg, monkeypatch, minutes):
    factory, _ = provider_pg
    spec = {"name": "EMA", "params": {"period": 2}}
    composite, _, stamp = pending_suffix(factory, monkeypatch, spec, minutes=minutes)
    with factory.begin() as db:
        page = chart_page(db, composite, "M1", count=3, now=stamp, provisional=True)
        run_id = fixed_indicators.request(db, page, spec, stamp=stamp).id
    owner = fixed_indicators.claim(run_id, alert_priority=True)
    if minutes <= 8:
        assert owner
        fixed_indicators.commit(owner, fixed_indicators.build(owner))
        with factory() as db:
            assert db.get(FixedIndicatorRun, run_id).status == "complete"
    else:
        assert owner is None
        with factory() as db:
            assert db.get(FixedIndicatorRun, run_id).lease_token is None
        drain(run_id)


def test_runtime_indicator_cannot_claim_first_history_initialization(provider_pg, monkeypatch):
    factory, _ = provider_pg
    composite, revision, seam, stamp = composite_contracts.continuous(factory, monkeypatch)
    composite_contracts.forming(factory, revision, seam + 600000, stamp)
    with factory.begin() as db:
        page = chart_page(db, composite, "M1", count=3, now=stamp, provisional=True)
        run_id = fixed_indicators.request(db, page, {"name": "EMA", "params": {"period": 2}},
                                          stamp=stamp).id
    assert fixed_indicators.claim(run_id, alert_priority=True) is None
    drain(run_id)


def test_late_old_instance_cannot_restore_replacement_health(provider_pg):
    factory, _ = provider_pg
    old = runtime_health.Progress("market", "chart_alert", "old")
    old.claim()
    new = runtime_health.Progress("market", "chart_alert", "new")
    new.claim()
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda pair: pair[0].record(**pair[1]), [
            (old, {}), (new, {"state": "degraded", "error": "RuntimeError"}),
        ]))
    with factory() as db:
        value = db.get(Preference, runtime_health.key("chart_alert")).value
        assert value["boot_id"] == "new" and value["error_type"] == "RuntimeError"


def test_new_owner_claim_waits_for_old_business_transaction_fence(provider_pg):
    old = runtime_health.Progress("market", "chart_alert", "old")
    old.claim()
    entered, release, claimed = threading.Event(), threading.Event(), threading.Event()

    def old_transaction():
        with runtime_health.reporting(old), transaction() as db:
            runtime_health.assert_current(db)
            entered.set()
            assert release.wait(5)

    def new_claim():
        runtime_health.Progress("market", "chart_alert", "new").claim()
        claimed.set()

    with ThreadPoolExecutor(max_workers=2) as pool:
        old_work = pool.submit(old_transaction)
        assert entered.wait(5)
        new_work = pool.submit(new_claim)
        assert not claimed.wait(.1)
        release.set()
        old_work.result(timeout=5)
        new_work.result(timeout=5)
    assert claimed.is_set()


def test_replaced_runtime_cannot_commit_claimed_indicator_page(provider_pg, monkeypatch):
    factory, _ = provider_pg
    monkeypatch.setattr("alerts.storage.Session", factory)
    spec = {"name": "EMA", "params": {"period": 2}}
    composite, _, stamp = pending_suffix(factory, monkeypatch, spec)
    with factory.begin() as db:
        page = chart_page(db, composite, "M1", count=3, now=stamp, provisional=True)
        run_id = fixed_indicators.request(db, page, spec, stamp=stamp).id
    old = runtime_health.Progress("market", "alert_indicator", "old")
    old.claim()
    with factory() as db:
        run = db.get(FixedIndicatorRun, run_id)
        assert run.status == "pending"
    from alerts.fixed_indicators import claim, commit

    monkeypatch.setattr("alerts.indicator_demands.warmup_capacity",
                        lambda *_args, **_kwargs: False)
    assert claim(run_id) is None
    ownership = claim(run_id, alert_priority=True)
    assert ownership
    replacement = runtime_health.Progress("market", "alert_indicator", "new")
    replacement.claim()
    with runtime_health.reporting(old), pytest.raises(runtime_health.RuntimeOwnershipLost):
        commit(ownership, None)
    with factory() as db:
        run = db.get(FixedIndicatorRun, run_id)
        assert run.next_at == 0 and run.lease_token == ownership["token"]


def test_transient_ema_cross_is_judged_while_indicator_run_warms(provider_pg, monkeypatch):
    factory, _ = provider_pg
    monkeypatch.setattr("alerts.storage.Session", factory)
    ident, _, revision, seam, stamp = composite_contracts.armed(factory, monkeypatch,
        mode="intrabar", seam_policy="accept_raw",
        condition={"relation": "cross_up",
            "left": {"kind": "indicator", "indicator": {
                "name": "EMA", "params": {"period": 2}, "output": "value"}},
            "right": {"kind": "constant", "value": "1.112"}})
    composite_contracts.forming(factory, revision, seam + 600000, stamp)
    assert composite_contracts.settle(factory, ident, stamp) == []
    with factory() as db:
        assert db.get(ChartAlert, ident).health == "ready"

    next_start = seam + 600000
    observation_at = next_start + 60000
    composite_contracts.forming(factory, revision, next_start, observation_at - 1000,
                                price="1.110")
    with factory.begin() as db:
        assert composite_contracts.evaluate(db, ident, now=observation_at - 1000) == []
    composite_contracts.append(factory, revision, next_start, "1.110", observation_at + 10)
    composite_contracts.forming(factory, revision, observation_at, observation_at + 20,
                                price="1.119")
    with factory.begin() as db:
        signal_ids = composite_contracts.evaluate(db, ident, now=observation_at + 20)
        row = db.get(ChartAlert, ident)
        signals = db.scalars(select(SignalRow).where(
            SignalRow.chart_alert_id == ident)).all()
        assert len(signal_ids) == 1, (row.health, row.health_reason, row.state, row.runtime)
        assert len(signals) == 1
        assert row.count == 1 and row.state["sequence"] == observation_at + 20
        calculation = row.runtime["indicators"][0]
        assert calculation["provisional_ready"] is True
        assert db.get(FixedIndicatorRun, calculation["run_id"]).status == "pending"
        assert row.runtime["readiness"]["ready"] is True
    composite_contracts.forming(factory, revision, observation_at, observation_at + 30,
                                price="1.110")
    with factory.begin() as db:
        assert composite_contracts.evaluate(db, ident, now=observation_at + 30) == []
        assert db.get(ChartAlert, ident).count == 1
        assert len(db.scalars(select(SignalRow).where(
            SignalRow.chart_alert_id == ident)).all()) == 1


def pending_suffix(factory, monkeypatch, spec, *, minutes=1, aggregate=True):
    composite, revision, seam, stamp = composite_contracts.continuous(factory, monkeypatch)
    with factory.begin() as db:
        page = chart_page(db, composite, "M1", count=3, now=stamp)
        initial_id = fixed_indicators.request(db, page, spec, stamp=stamp).id
    drain(initial_id)
    start = seam + 600000
    end = start + minutes * 60000
    add_tail(factory, revision, [minute(start + i * 60000, volume="3",
        close=str(1.111 + i * .0001)) for i in range(minutes)], observed_at=end)
    if aggregate:
        composite_contracts.aggregate(revision, "M1")
    composite_contracts.forming(factory, revision, end, end + 10, price="1.119")
    return composite, revision, end + 10


@pytest.mark.parametrize("spec", [
    {"name": "SMA", "params": {"period": 2}},
    {"name": "EMA", "params": {"period": 2}},
    {"name": "RSI", "params": {"period": 2}},
    {"name": "MACD", "params": {"fast": 2, "slow": 3, "signal": 2}},
    {"name": "ROLLING_RANGE_SQUEEZE", "params": {"k": 2, "lookback": 20}},
])
@pytest.mark.parametrize("minutes", [1, 8])
def test_alert_suffix_matches_durable_worker_without_publishing(provider_pg, monkeypatch, spec, minutes):
    factory, _ = provider_pg
    composite, _, stamp = pending_suffix(factory, monkeypatch, spec, minutes=minutes)
    with factory.begin() as db:
        page = chart_page(db, composite, "M1", count=3, now=stamp, provisional=True)
        run = fixed_indicators.request(db, page, spec, stamp=stamp)
        assert run.status == "pending" and run.parent_id
        before = {column.name: copy.deepcopy(getattr(run, column.name))
                  for column in FixedIndicatorRun.__table__.columns}
        blocks = db.scalar(select(func.count()).select_from(FixedIndicatorBlock))
        preview, progress = fixed_indicators.chart_results(
            db, page, [spec], provisional=True, purpose="alert", stamp=stamp)
        assert progress[0]["provisional_ready"] is True
        assert progress[0]["execution"]["path"] == "alert-checkpoint-suffix"
        assert {column.name: getattr(run, column.name)
                for column in FixedIndicatorRun.__table__.columns} == before
        assert db.scalar(select(func.count()).select_from(FixedIndicatorBlock)) == blocks
        full_page = chart_page(db, composite, "M1", count=200, now=stamp, provisional=True)
        oracle = calculate(full_page["bars"], spec, provisional=True)
        for actual, expected in zip(preview[0]["series"], oracle["series"], strict=True):
            expected_values = {row["time"]: row["value"] for row in expected["values"]}
            assert [row["value"] for row in actual["values"]] == pytest.approx(
                [expected_values[row["time"]] for row in actual["values"]])
        run_id = run.id
    drain(run_id)
    with factory.begin() as db:
        complete, progress = fixed_indicators.chart_results(
            db, page, [spec], provisional=True, purpose="alert", stamp=stamp)
        assert progress[0]["status"] == "complete"
        assert preview[0]["series"] == complete[0]["series"]
        assert preview[0]["dependencies"] == complete[0]["dependencies"]
        if "presentation" in preview[0]:
            assert {k: v for k, v in preview[0]["presentation"].items()
                    if k != "history_complete"} == {
                        k: v for k, v in complete[0]["presentation"].items()
                        if k != "history_complete"}


@pytest.mark.parametrize("scenario", ["initial", "long", "unpublished"])
def test_alert_suffix_waits_for_initialization_long_repair_or_waterline(provider_pg, monkeypatch, scenario):
    factory, _ = provider_pg
    spec = {"name": "EMA", "params": {"period": 2}}
    if scenario == "initial":
        composite, revision, seam, stamp = composite_contracts.continuous(factory, monkeypatch)
        composite_contracts.forming(factory, revision, seam + 600000, stamp)
    else:
        composite, _, stamp = pending_suffix(factory, monkeypatch, spec,
            minutes=9 if scenario == "long" else 1, aggregate=scenario != "unpublished")
    with factory.begin() as db:
        page = chart_page(db, composite, "M1", count=3, now=stamp, provisional=True)
        run = fixed_indicators.request(db, page, spec, stamp=stamp)
        assert run.status == "pending"
        assert fixed_indicators.alert_append(db, run) is None
        _, progress = fixed_indicators.chart_results(
            db, page, [spec], provisional=True, purpose="alert", stamp=stamp)
        assert not progress[0].get("provisional_ready")


@pytest.mark.parametrize("change", ["correction", "epoch", "gap"])
def test_alert_suffix_cannot_turn_recovery_or_missing_inputs_into_crossings(provider_pg, monkeypatch, change):
    factory, _ = provider_pg
    ident, _, revision, seam, stamp = composite_contracts.armed(factory, monkeypatch,
        mode="intrabar", seam_policy="accept_raw",
        condition={"relation": "cross_up", "left": {"kind": "indicator", "indicator": {
            "name": "EMA", "params": {"period": 2}}},
            "right": {"kind": "constant", "value": "1.112"}})
    composite_contracts.forming(factory, revision, seam + 600000, stamp)
    assert composite_contracts.settle(factory, ident, stamp) == []
    at = seam + 600000
    observed = at + 60000
    composite_contracts.forming(factory, revision, at, observed - 1000)
    with factory.begin() as db:
        assert composite_contracts.evaluate(db, ident, now=observed - 1000) == []
    if change == "gap":
        at += 60000
        observed += 60000
    composite_contracts.append(factory, revision, at, "1.110", observed + 10)
    if change == "correction":
        add_tail(factory, revision, [minute(seam + 540000, volume="3", close="1.118")])
        composite_contracts.aggregate(revision, "M1")
    composite_contracts.forming(factory, revision, at + 60000, observed + 20,
        price="1.119", epoch=2 if change == "epoch" else 1)
    with factory.begin() as db:
        assert composite_contracts.evaluate(db, ident, now=observed + 20) == []
        row = db.get(ChartAlert, ident)
        assert row.count == 0 and db.scalar(select(SignalRow)) is None
        if change == "correction":
            # The corrected input precedes the parent's only checkpoint, so
            # replay must finish before a recovery baseline can be established.
            assert row.health == "warming"
        else:
            assert row.runtime["readiness"]["last_outcome"] == "recovery_baseline"
            if change == "gap":
                dependency = row.runtime["readiness"]["dependencies"][0]["dependency"]
                assert dependency["dependency_origin"] == at
    if change == "correction":
        assert composite_contracts.settle(factory, ident, observed + 20) == []
        with factory() as db:
            row = db.get(ChartAlert, ident)
            assert row.runtime["readiness"]["last_outcome"] == "recovery_baseline"
            assert row.count == 0 and db.scalar(select(SignalRow)) is None


def test_source_commit_between_clock_capture_and_locked_read(provider_pg, monkeypatch):
    race_contract(provider_pg[0], monkeypatch)


def test_initialized_atr_reference_does_not_wait_for_unneeded_indicator_tail(provider_pg, monkeypatch):
    from alerts.chart_alert_service import create

    factory, _ = provider_pg
    # The generic historical helper otherwise uses a confirmation timestamp
    # later than this scenario's live clock, correctly invoking recovery.
    monkeypatch.setattr(composite_contracts, "add_tail", lambda database, rev, rows, **kwargs:
        add_tail(database, rev, rows, **{**kwargs,
            "observed_at": max(row.timestamp for row in rows) + 60000}))
    composite, revision, seam, stamp = composite_contracts.continuous(factory, monkeypatch)
    condition = {"relation": "cross_up", "right": {"kind": "constant", "value": "1.115"},
                 "offset": {"kind": "atr", "timeframe": "M1", "period": 2, "multiplier": ".01"}}
    with factory.begin() as db:
        ident = create(db, "atr-reference", composite_contracts.config(composite,
            condition=condition, seam_policy="accept_raw"), at=stamp).id
    assert composite_contracts.settle(factory, ident, stamp) == []
    stamp = seam + 660010
    composite_contracts.append(factory, revision, seam + 600000, "1.119", stamp)
    with factory.begin() as db:
        events = composite_contracts.evaluate(db, ident, now=stamp)
        alert = db.get(ChartAlert, ident)
        assert len(events) == 1, (alert.health, alert.health_reason)
        dependency = alert.runtime["offset_indicators"][0]
        run = db.get(FixedIndicatorRun, dependency["run_id"])
        assert run.status == "pending" and run.cursor < run.target_end
        assert run.cursor >= alert.runtime["offset"]["reference_end"]
        assert alert.runtime["offset"]["reference_end"] == seam + 600000
        assert db.scalar(select(func.count()).select_from(SignalRow)) == 1
        signal = db.scalar(select(SignalRow))
        assert signal.evidence["observation"]["offset"]["atr"] == alert.runtime["offset"]["atr"]
    # Advancing the unrelated suffix changes neither this reference nor the
    # already committed logical event.
    while fixed_indicators.indicator_tick(dependency["run_id"]):
        pass
    with factory.begin() as db:
        assert composite_contracts.evaluate(db, ident, now=stamp) == []
        assert db.scalar(select(func.count()).select_from(SignalRow)) == 1


@pytest.mark.parametrize("writer_kind", ["quote", "legacy"])
def test_quote_publication_and_composite_judgment_keep_dataset_lock_order(provider_pg, monkeypatch, writer_kind):
    """A real quote writer must not hold LiveState while waiting on its reader's dataset."""
    from alerts.config import settings
    from alerts.live_pricing import account_key, publish_event
    from alerts.market_contracts import DatasetIdentity, QuoteEvent
    from alerts.storage import (
        CompositeRevision,
        LiveState,
        MarketDataset,
        ObservedMinute,
        PricingOwner,
        RealtimeMapping,
    )

    factory, engine = provider_pg
    ident, _, revision, _, stamp = composite_contracts.armed(factory, monkeypatch, mode="intrabar")
    composite_contracts.forming(factory, revision, stamp // 60000 * 60000, stamp)
    with factory.begin() as db:
        target = db.get(RealtimeMapping, db.get(CompositeRevision, revision).mapping_id).target_dataset_id
        identity = DatasetIdentity.model_validate(db.get(MarketDataset, target).identity)
        owner = db.get(PricingOwner, account_key(settings.oanda_account_id))
        ownership, epoch = (owner.id, owner.token), owner.epoch
        # The semantic helper's legacy quote omits sequence/identity. A wire
        # publication must begin with the complete preceding QuoteEvent.
        db.get(LiveState, target).quote = QuoteEvent(identity=identity, bid="1.110", ask="1.111",
            tradeable=True, source_time=stamp, received_at=stamp, sequence=stamp,
            connection_epoch=epoch).model_dump(mode="json")
        schema = db.scalar(text("SELECT current_schema()"))
        assert composite_contracts.evaluate(db, ident, now=stamp) == []
        assert Decimal(db.get(ChartAlert, ident).state["left"]) == Decimal("1.11")
        if writer_kind == "legacy":
            db.execute(delete(Preference).where(Preference.key == "display_handover:" + target))
            db.execute(delete(ObservedMinute).where(ObservedMinute.dataset_id == target))
    observer = create_engine(engine.url.update_query_dict({"options": f"-csearch_path={schema}"}),
                             pool_size=1, max_overflow=0)
    quoted = QuoteEvent(identity=identity, bid="1.119", ask="1.120", tradeable=True,
        source_time=stamp + 1000, received_at=stamp + 1000, sequence=stamp + 1000,
        connection_epoch=epoch)
    reader_at_state, release_reader, writer_started = (threading.Event() for _ in range(3))
    context = threading.local()
    writer_pids = []

    def before(connection, _cursor, statement, _parameters, _execution, _many):
        role = getattr(context, "role", None)
        if role == "writer" and not writer_pids:
            writer_pids.append(connection.connection.driver_connection.info.backend_pid)
            writer_started.set()

    def after(_connection, _cursor, statement, _parameters, _execution, _many):
        role = getattr(context, "role", None)
        if (role == "reader" and not reader_at_state.is_set()
                and "SELECT market_datasets.id" in statement and "FOR UPDATE" in statement):
            reader_at_state.set()
            assert release_reader.wait(10), "source writer did not reach the contested lock"

    def reader():
        context.role = "reader"
        with factory.begin() as db:
            return composite_contracts.evaluate(db, ident, now=stamp + 1000)

    def writer():
        context.role = "writer"
        if writer_kind == "legacy":
            from alerts.display_observations import handover_legacy

            with factory.begin() as db:
                handover_legacy(db, db.get(LiveState, target))
            return
        return publish_event(ownership, epoch, quoted, {identity.provider_symbol: identity}, now=stamp + 1000)

    event.listen(engine, "before_cursor_execute", before)
    event.listen(engine, "after_cursor_execute", after)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            reading = pool.submit(reader)
            try:
                assert reader_at_state.wait(5), "judgment did not acquire its dataset locks"
                writing = pool.submit(writer)
                assert writer_started.wait(5)
                deadline = time.monotonic() + 5
                with observer.connect() as connection:
                    while time.monotonic() < deadline:
                        if writing.done():
                            writing.result()
                            pytest.fail("quote committed while the judgment held its dataset lock")
                        waiting = connection.scalar(text(
                            "SELECT wait_event_type = 'Lock' AND wait_event IN ('transactionid', 'tuple') "
                            "FROM pg_stat_activity WHERE pid = :pid"
                        ), {"pid": writer_pids[0]})
                        connection.commit()
                        if waiting:
                            break
                        time.sleep(.01)
                    else:
                        pytest.fail("quote writer did not contend with the judgment transaction")
                release_reader.set()
                assert reading.result(timeout=5) == []
                assert writing.result(timeout=5) == ("accepted" if writer_kind == "quote" else None)
            finally:
                release_reader.set()
        with factory.begin() as db:
            signals = composite_contracts.evaluate(db, ident, now=stamp + 1000)
            alert = db.get(ChartAlert, ident)
            assert len(signals) == (1 if writer_kind == "quote" else 0), (
                alert.health, alert.health_reason, alert.state, alert.runtime)
            if writer_kind == "legacy":
                assert db.get(Preference, "display_handover:" + target).value["adopted_last_quote"]
                assert db.scalar(select(func.count()).select_from(ObservedMinute).where(
                    ObservedMinute.dataset_id == target)) == 1
    finally:
        event.remove(engine, "before_cursor_execute", before)
        event.remove(engine, "after_cursor_execute", after)
        observer.dispose()


@pytest.mark.parametrize("query_kind", ["chart_data", "chart_page"])
@pytest.mark.parametrize("counterparty", ["judgment", "confirmation"])
def test_first_legacy_chart_read_and_judgment_lock_both_datasets_in_order(
        provider_pg, monkeypatch, query_kind, counterparty):
    """The complete first chart read also needs its fixed historical prefix."""
    from alerts.chart_query import DataQuery
    from alerts.config import settings
    from alerts.live_pricing import account_key, commit_confirmation
    from alerts.market_contracts import DatasetIdentity, QuoteEvent
    from alerts.series_access import chart_data
    from alerts.storage import (
        CompositeRevision,
        HistoryVersion,
        LiveState,
        MarketDataset,
        ObservedMinute,
        PricingOwner,
        RealtimeMapping,
    )
    from test_market_contracts import batch

    factory, engine = provider_pg
    monkeypatch.setattr(settings, "oanda_calendar_version", "chart-lock-2")
    ident, composite, revision, seam, stamp = composite_contracts.armed(factory, monkeypatch, mode="intrabar")
    composite_contracts.forming(factory, revision, stamp // 60000 * 60000, stamp)
    monkeypatch.setattr("alerts.series_access.now_ms", lambda: stamp)
    with factory.begin() as db:
        selected = db.get(CompositeRevision, revision)
        target = db.get(RealtimeMapping, selected.mapping_id).target_dataset_id
        history = db.get(HistoryVersion, selected.history_version_id).dataset_id
        assert history < target, "fixture must exercise the target-before-history inversion"
        identity = DatasetIdentity.model_validate(db.get(MarketDataset, target).identity)
        owner = db.get(PricingOwner, account_key(settings.oanda_account_id))
        ownership, epoch = (owner.id, owner.token), owner.epoch
        db.get(LiveState, target).quote = QuoteEvent(identity=identity, bid="1.110", ask="1.111",
            tradeable=True, source_time=stamp, received_at=stamp, sequence=stamp,
            connection_epoch=epoch).model_dump(mode="json")
        assert composite_contracts.evaluate(db, ident, now=stamp) == []
        db.execute(delete(Preference).where(Preference.key == "display_handover:" + target))
        db.execute(delete(ObservedMinute).where(ObservedMinute.dataset_id == target))
        schema = db.scalar(text("SELECT current_schema()"))
    observer = create_engine(engine.url.update_query_dict({"options": f"-csearch_path={schema}"}),
                             pool_size=1, max_overflow=0)
    browser_locked, release_browser, judgment_started = (threading.Event() for _ in range(3))
    context = threading.local()
    judgment_pids = []

    def before(connection, _cursor, _statement, _parameters, _execution, _many):
        if getattr(context, "role", None) == "judgment" and not judgment_pids:
            judgment_pids.append(connection.connection.driver_connection.info.backend_pid)
            judgment_started.set()

    def after(_connection, _cursor, statement, _parameters, _execution, _many):
        if (getattr(context, "role", None) == "browser" and not browser_locked.is_set()
                and "SELECT market_datasets.id" in statement and "FOR " in statement):
            browser_locked.set()
            assert release_browser.wait(10), "judgment did not contend with the chart read"

    def browser():
        context.role = "browser"
        with factory.begin() as db:
            if query_kind == "chart_data":
                return chart_data(db, DataQuery(instrument=composite, series_kind="composite",
                                               timeframe="M1", limit=100, provisional=True))
            return chart_page(db, composite, "M1", count=100, provisional=True, now=stamp)

    def judgment():
        context.role = "judgment"
        if counterparty == "confirmation":
            return commit_confirmation(ownership, epoch, batch(identity=identity,
                window_start=seam + 540000, window_end=seam + 600000, checkpoint=seam + 600000,
                observed_at=stamp, rows=(minute(seam + 540000, volume="3"),),
                volume_kind="price_count", volume_unit="quotes"), now=stamp)
        with factory.begin() as db:
            return composite_contracts.evaluate(db, ident, now=stamp)

    event.listen(engine, "before_cursor_execute", before)
    event.listen(engine, "after_cursor_execute", after)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            browsing = pool.submit(browser)
            try:
                assert browser_locked.wait(5), "chart did not pin a dataset"
                judging = pool.submit(judgment)
                assert judgment_started.wait(5)
                with observer.connect() as connection:
                    deadline = time.monotonic() + 5
                    while time.monotonic() < deadline:
                        if judging.done():
                            judging.result()
                            pytest.fail("judgment completed while the chart held its dataset lock")
                        waiting = connection.scalar(text(
                            "SELECT wait_event_type = 'Lock' AND wait_event IN ('transactionid', 'tuple') "
                            "FROM pg_stat_activity WHERE pid = :pid"), {"pid": judgment_pids[0]})
                        connection.commit()
                        if waiting:
                            break
                        time.sleep(.01)
                    else:
                        pytest.fail("judgment did not wait for the chart transaction")
                release_browser.set()
                page = browsing.result(timeout=5)
                assert any(bar["start"] < seam for bar in page["bars"])
                assert judging.result(timeout=5) == ([] if counterparty == "judgment" else None)
            finally:
                release_browser.set()
        with factory() as db:
            assert db.get(ChartAlert, ident).count == 0
            assert db.get(Preference, "display_handover:" + target).value["adopted_last_quote"]
    finally:
        event.remove(engine, "before_cursor_execute", before)
        event.remove(engine, "after_cursor_execute", after)
        observer.dispose()


def test_lost_ownership_session_stops_the_old_runtime_group(provider_pg):
    _, engine = provider_pg
    owner_connections = []

    def captured(connection, _cursor, statement, _parameters, _context, _many):
        if "pg_try_advisory_lock" in statement:
            owner_connections.append(connection)

    event.listen(engine, "after_cursor_execute", captured)
    stopped = threading.Event()
    try:
        with market_runtime.ownership(engine) as check:
            pid = owner_connections[-1].scalar(text("SELECT pg_backend_pid()"))
            owner_connections[-1].commit()
            with engine.begin() as killer:
                assert killer.scalar(text("SELECT pg_terminate_backend(:pid)"), {"pid": pid})
            with pytest.raises(RuntimeGroupError):
                run_group([Loop("ownership", check), Loop("sibling", lambda stop: stop.wait())],
                          stop=stopped, handle_signals=False)
        assert stopped.is_set()
        with market_runtime.ownership(engine):
            pass
    finally:
        event.remove(engine, "after_cursor_execute", captured)


def test_api_independent_input_aggregate_and_alert_runtime_chain(provider_pg, monkeypatch):
    """Actual runtime profiles consume a new PG input without an API owner."""
    factory, _ = provider_pg
    monkeypatch.setattr("alerts.storage.Session", factory)
    from alerts import alert_runtime, storage

    monkeypatch.setattr("alerts.config.settings.database_pool_size", 8)
    with factory() as db:
        schema = db.scalar(text("SELECT current_schema()"))
    runtime_url = factory.kw["bind"].url.update_query_dict(
        {"options": f"-csearch_path={schema}"})
    market_engine = storage.make_engine(runtime_url.render_as_string(hide_password=False))
    runtime_factory = sessionmaker(market_engine, expire_on_commit=False)
    monkeypatch.setattr(storage, "engine", market_engine)
    monkeypatch.setattr(storage, "Session", runtime_factory)
    monkeypatch.setattr(storage, "bootstrap", lambda *_args, **_kwargs: None)
    monkeypatch.setattr("alerts.config.settings.market_runtime_chart_alert_enabled", False)
    monkeypatch.setattr("alerts.config.settings.oanda_native_latest_owner", "provider")
    ident, _, revision, seam, stamp = composite_contracts.armed(factory, monkeypatch,
        condition={"relation": "cross_up",
            "left": {"kind": "price"},
            "right": {"kind": "constant", "value": "1.112"}})
    next_end = seam + 660010
    clock = [stamp]
    monkeypatch.setattr("alerts.chart_alert_worker.now_ms", lambda: clock[0])
    # A synthetic minute jump must not become visible before its matching
    # source observation. Real clocks advance continuously; serialize this
    # fixture's jump with complete worker steps instead of inventing staleness.
    from alerts import chart_alert_worker

    source_update = threading.Lock()
    original_step = chart_alert_worker.step

    def controlled_step(**kwargs):
        with source_update:
            return original_step(**kwargs)

    monkeypatch.setattr(chart_alert_worker, "step", controlled_step)
    stop_market, stop_alert = threading.Event(), threading.Event()
    failures = []

    def run_profile(profile, stop):
        try:
            if profile == "market":
                market_runtime.run(stop=stop, handle_signals=False)
            else:
                alert_runtime.run(stop=stop, handle_signals=False)
        except BaseException as error:
            failures.append((profile, error))

    market_thread = threading.Thread(target=run_profile, args=("market", stop_market))
    alert_thread = threading.Thread(target=run_profile, args=("alert", stop_alert))
    market_thread.start()
    alert_thread.start()

    def wait_for(predicate, timeout=15):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return
            if failures:
                pytest.fail(f"Runtime profile failed: {failures!r}")
            time.sleep(.05)
        with factory() as db:
            alert = db.get(ChartAlert, ident)
            details = {
                "alert": {"status": alert.status, "health": alert.health,
                          "reason": alert.health_reason, "runtime": alert.runtime},
                "runtime_roles": [db.get(Preference, runtime_health.key(role)).value
                    for role in ("pricing", "realtime", "composite_aggregate",
                                 "alert_indicator", "chart_alert", "market_ownership")],
                "aggregate": db.get(CompositeAggregateTask, (revision, "M1")).applied_input_revision,
                "input": db.get(CompositePreparation, revision).input_revision,
            }
        pytest.fail(f"Runtime profiles did not advance the expected input: {details!r}")

    try:
        def prepared():
            with factory() as db:
                row = db.get(ChartAlert, ident)
                return row.health == "ready"

        wait_for(prepared)
        with source_update:
            add_tail(factory, revision, [minute(seam + 600000, volume="3", close="1.119")],
                     observed_at=next_end)
            composite_contracts.live(factory, revision, next_end, seam + 660000)
            clock[0] = next_end

        def signaled():
            with factory() as db:
                return db.scalar(select(SignalRow.id).where(
                    SignalRow.chart_alert_id == ident)) is not None

        wait_for(signaled)
        with factory() as db:
            row = db.get(ChartAlert, ident)
            prep = db.get(CompositePreparation, revision)
            task = db.get(CompositeAggregateTask, (revision, "M1"))
            events = db.scalars(select(SignalRow).where(
                SignalRow.chart_alert_id == ident)).all()
            assert row.count == 1 and row.state["sequence"] >= next_end - 10000
            assert task.applied_input_revision == prep.input_revision
            assert len(events) == 1
    finally:
        stop_market.set()
        stop_alert.set()
        market_thread.join(35)
        alert_thread.join(35)
        market_engine.dispose()
    assert not market_thread.is_alive() and not alert_thread.is_alive()
    assert not failures
