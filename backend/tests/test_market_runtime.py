import threading
from contextlib import nullcontext
from types import SimpleNamespace

import pytest
from alerts import alert_monitor, chart_alert_worker, market_runtime
from alerts.storage import ChartAlert, SignalRow
from sqlalchemy import func, select
from test_composite_alerts import append, armed


def test_market_profile_has_one_fixed_owner_for_each_runtime_role():
    loops = market_runtime.build_loops()

    assert [loop.role for loop in loops] == [
        "pricing", "realtime", "composite_aggregate", "alert_indicator", "chart_alert",
    ]
    assert len({loop.role for loop in loops}) == len(loops)


def test_failed_old_alert_turn_cannot_overwrite_replacement_health(database, monkeypatch):
    from alerts import runtime_health

    ident, *_ = armed(database, monkeypatch)
    old = runtime_health.Progress("market", "chart_alert", "old")
    old.claim()

    def fail(*_args, **_kwargs):
        raise TimeoutError("controlled evaluation failure")

    def replace_after_rollback(_error):
        runtime_health.Progress("market", "chart_alert", "replacement").claim()
        with database.begin() as db:
            row = db.get(ChartAlert, ident)
            row.health, row.health_reason = "ready", None

    monkeypatch.setattr(chart_alert_worker, "evaluate", fail)
    with runtime_health.reporting(old), pytest.raises(runtime_health.RuntimeOwnershipLost):
        chart_alert_worker.step(on_error=replace_after_rollback)

    with database() as db:
        row = db.get(ChartAlert, ident)
        assert row.health == "ready" and row.health_reason is None


def test_market_profile_bootstraps_before_starting_owned_loops(monkeypatch):
    calls = []
    stop = threading.Event()
    stop.set()
    loops = (SimpleNamespace(role="chart_alert", run=lambda _: None),)
    monkeypatch.setattr("alerts.config.settings.oanda_native_latest_owner", "provider")

    monkeypatch.setattr("alerts.storage.bootstrap", lambda: calls.append("bootstrap"))
    monkeypatch.setattr("alerts.swing_sr.register_indicator", lambda: calls.append("indicator"))
    monkeypatch.setattr(market_runtime, "ownership", lambda _: nullcontext())
    monkeypatch.setattr(market_runtime, "chart_alert_ownership", lambda _: nullcontext())
    monkeypatch.setattr(market_runtime.runtime_health.Progress, "claim", lambda _: None)
    monkeypatch.setattr("alerts.provider_transport.close_clients", lambda: calls.append("closed"))
    monkeypatch.setattr(
        market_runtime, "run_group",
        lambda selected, **kwargs: calls.append((selected[0].role, kwargs["stop"], kwargs["handle_signals"])),
    )

    market_runtime.run(stop=stop, loops=loops, handle_signals=False)

    assert calls == ["indicator", "bootstrap", ("chart_alert", stop, False), "closed"]


def test_runtime_cli_dispatches_only_the_requested_fixed_profile(monkeypatch):
    from alerts import runtime

    calls = []
    monkeypatch.setattr(runtime.market_runtime, "run", lambda **kwargs: calls.append(kwargs))
    monkeypatch.setattr(runtime, "market_runtime", SimpleNamespace(run=lambda **kwargs: calls.append(kwargs)))

    runtime.run("market", handle_signals=False)

    assert calls == [{"stop": None, "handle_signals": False}]


def test_runtime_cli_dispatches_independent_alert_profile(monkeypatch):
    from alerts import alert_runtime, runtime

    calls = []
    monkeypatch.setattr(alert_runtime, "run", lambda **kwargs: calls.append(kwargs))

    runtime.run("alert", stop="stop", handle_signals=False, on_alert="observer")

    assert calls == [{"stop": "stop", "handle_signals": False,
                      "on_alert": "observer"}]


def test_market_profile_can_leave_chart_alert_to_independent_owner(monkeypatch):
    from alerts.config import settings

    monkeypatch.setattr(settings, "market_runtime_chart_alert_enabled", False)
    assert [loop.role for loop in market_runtime.build_loops()] == [
        "pricing", "realtime", "composite_aggregate", "alert_indicator",
    ]


def test_runtime_rejects_unknown_profile_before_startup():
    from alerts.runtime import run

    try:
        run("arbitrary")
    except ValueError as error:
        assert str(error) == "Unsupported runtime profile: arbitrary"
    else:
        raise AssertionError("unsupported runtime profile must be rejected")


def test_chart_alert_runtime_advances_without_api_lifespan(database, monkeypatch):
    stop = threading.Event()
    ident, _composite, revision, seam, stamp = armed(database, monkeypatch)
    clock = [stamp]
    monkeypatch.setattr(chart_alert_worker, "now_ms", lambda: clock[0])
    turns = []

    def next_input(turn):
        turns.append(turn)
        if len(turns) == 1:
            clock[0] = seam + 660010
            append(database, revision, seam + 600000, "1.119", clock[0])
        elif len(turns) == 3:
            stop.set()

    def run_monitor(shared_stop):
        alert_monitor.run(
            shared_stop, period=.01,
            on_turn=next_input,
            report_health=lambda *_args, **_kwargs: None,
        )

    from alerts.runtime_supervisor import Loop, run_group

    run_group([Loop("chart_alert", run_monitor)], stop=stop, handle_signals=False)

    assert len(turns) == 3 and all(turn["error"] is None for turn in turns)
    with database() as db:
        row = db.get(ChartAlert, ident)
        assert row.status == "active"
        assert row.health == "ready" and row.count == 1
        assert db.scalar(select(func.count()).select_from(SignalRow)) == 1


def test_alert_indicator_worker_advances_only_active_rule_dependencies(database, monkeypatch):
    from alerts import alert_indicator_worker

    ident, *_ = armed(database, monkeypatch)
    with database.begin() as db:
        row = db.get(ChartAlert, ident)
        row.runtime = {"indicators": [
            {"run_id": "active-run", "status": "pending"},
            {"run_id": "finished-run", "status": "complete"},
        ], "offset_indicators": [
            {"run_id": "atr-run", "status": "pending"},
        ]}
    calls = []
    monkeypatch.setattr(alert_indicator_worker, "indicator_tick",
                        lambda run_id, **kwargs: calls.append((run_id, kwargs)) or run_id == "atr-run")

    assert alert_indicator_worker.tick()
    assert calls == [("active-run", {"alert_priority": True, "raise_errors": True}),
                     ("atr-run", {"alert_priority": True, "raise_errors": True})]


def test_realtime_runtime_does_not_acquire_browser_viewer_inputs(database, monkeypatch):
    from alerts import realtime_worker

    stop = threading.Event()
    calls = []

    def one_cycle(*, include_viewers, **_kwargs):
        calls.append(include_viewers)
        stop.set()

    monkeypatch.setattr(realtime_worker, "once", one_cycle)
    monkeypatch.setattr(realtime_worker, "import_once", lambda **_kwargs: None)

    realtime_worker.run(stop)

    assert calls == [False]


def test_aggregate_success_cannot_clear_other_period_in_backoff(database, monkeypatch):
    from alerts import composite_aggregate_worker as worker
    from alerts import composite_aggregates as cache
    from alerts.storage import CompositeAggregateTask
    from test_composite_chart import populated

    _, revision, _ = populated(database, monkeypatch)
    build = cache.build

    def fail(_owner):
        raise ValueError("controlled period failure")

    monkeypatch.setattr(cache, "build", fail)
    assert cache.aggregate_tick(revision, "H4")
    monkeypatch.setattr(cache, "build", build)
    assert cache.aggregate_tick(revision, "M1")
    states = []
    monkeypatch.setattr(worker, "progress", lambda **value: states.append(value))
    stopped = SimpleNamespace(is_set=lambda: len(states) >= 3)

    def retry(_delay):
        if len(states) == 2:
            with database.begin() as db:
                db.get(CompositeAggregateTask, (revision, "H4")).next_at = 0
            assert cache.aggregate_tick(revision, "H4")

    stopped.wait = retry
    worker.run(stopped)
    assert [row["error"] for row in states] == ["ValueError", "ValueError", None]
    assert [row["state"] for row in states[:2]] == ["degraded", "degraded"]


def test_disabled_composite_is_not_claimed_for_runtime_aggregation(database, monkeypatch):
    from alerts.composite_aggregates import claim
    from alerts.realtime_switch import set_enabled
    from alerts.storage import CompositeRevision, HistoryVersion, MarketDataset
    from test_composite_chart import populated

    _, revision, _ = populated(database, monkeypatch)
    with database.begin() as db:
        history = db.get(HistoryVersion, db.get(CompositeRevision, revision).history_version_id)
        source = db.get(MarketDataset, history.dataset_id).instrument_id
        set_enabled(db, source, False, now=100000)
    assert claim(revision, "H4", runtime_only=True) is None
    # Historical/maintenance preparation keeps its bounded legacy entry point.
    assert claim(revision, "H4") is not None


def test_provider_owned_latest_is_excluded_from_runtime_rest_specs(monkeypatch):
    from alerts import oanda_worker, provider_cache
    from alerts.config import settings

    monkeypatch.setattr(settings, "oanda_acquisition_mode", "rest_batch")
    monkeypatch.setattr(settings, "oanda_native_latest_owner", "provider")
    monkeypatch.setattr(oanda_worker, "desired_native_provider_datasets",
                        lambda _: (_ for _ in ()).throw(AssertionError("provider work in runtime")))
    assert oanda_worker.native_specs("fixture") == ()
    assert provider_cache.rest_batch_owner_active("fixture") is False


@pytest.mark.parametrize("failure", ["backoff", "replacement"])
def test_indicator_failure_remains_degraded_during_backoff_and_clears_after_success(database, monkeypatch, failure):
    from alerts import alert_indicator_worker, fixed_indicators, runtime_health
    from alerts.chart_alert_service import create
    from alerts.storage import FixedIndicatorRun, Preference
    from test_composite_alerts import config, live
    from test_market_runtime_postgres import pending_suffix

    composite, revision, stamp = pending_suffix(database, monkeypatch,
                                         {"name": "EMA", "params": {"period": 2}})
    live(database, revision, stamp, stamp - 10)
    from alerts.composite_chart import chart_page

    with database.begin() as db:
        page = chart_page(db, composite, "M1", count=3, now=stamp, provisional=True)
        run_id = fixed_indicators.request(db, page, {"name": "EMA", "params": {"period": 2}},
                                          stamp=stamp).id
        ident = create(db, "composite-rule", config(composite), at=stamp).id
        db.get(ChartAlert, ident).runtime = {"indicators": [{"run_id": run_id, "status": "pending"}]}
    reporter = runtime_health.Progress("market", "alert_indicator", "indicator-owner")
    reporter.claim()
    with runtime_health.reporting(reporter):
        runtime_health.progress()
    with database() as db:
        initial_success = db.get(Preference, runtime_health.key("alert_indicator")).value["last_success_at"]
    build = fixed_indicators.build
    turns = []

    def broken(_owner):
        if failure == "replacement":
            with database.begin() as db:
                db.get(FixedIndicatorRun, run_id).lease_token = "replacement-lease"
        raise ValueError("fixture calculation failure")

    monkeypatch.setattr(fixed_indicators, "build", broken)
    stop = SimpleNamespace(is_set=lambda: len(turns) == 3)

    def next_turn(_delay):
        with database() as db:
            turns.append(dict(db.get(Preference, runtime_health.key("alert_indicator")).value))
        if len(turns) == 1:
            monkeypatch.setattr(fixed_indicators, "build", build)
        elif len(turns) == 2:
            with database.begin() as db:
                row = db.get(FixedIndicatorRun, run_id)
                row.next_at, row.lease_until = 0, 0

    stop.wait = next_turn
    with runtime_health.reporting(reporter):
        alert_indicator_worker.run(stop)
    assert [(item["state"], item["error_type"]) for item in turns] == [
        ("degraded", "ValueError"), ("degraded", "ValueError"), ("running", None)]
    assert all(item["last_success_at"] == initial_success for item in turns[:2])
    with database() as db:
        assert db.get(FixedIndicatorRun, run_id).status == "complete"


@pytest.mark.parametrize("lost", ["expired", "replaced"])
def test_failed_indicator_does_not_report_success_after_losing_its_lease(database, monkeypatch, lost):
    from alerts import fixed_indicators
    from alerts.composite_chart import chart_page
    from alerts.storage import FixedIndicatorRun
    from test_market_runtime_postgres import pending_suffix

    spec = {"name": "EMA", "params": {"period": 2}}
    composite, _, stamp = pending_suffix(database, monkeypatch, spec)
    with database.begin() as db:
        page = chart_page(db, composite, "M1", count=3, now=stamp, provisional=True)
        run_id = fixed_indicators.request(db, page, spec, stamp=stamp).id

    def failed(owner):
        with database.begin() as db:
            run = db.get(FixedIndicatorRun, owner["id"])
            if lost == "expired":
                run.lease_until = 0
            else:
                run.lease_token = "replacement-lease"
        raise ValueError("fixture calculation failure after lease loss")

    monkeypatch.setattr(fixed_indicators, "build", failed)
    with pytest.raises(ValueError, match="fixture calculation failure"):
        fixed_indicators.indicator_tick(run_id, alert_priority=True, raise_errors=True)
    with database() as db:
        run = db.get(FixedIndicatorRun, run_id)
        assert run.error is None and run.attempts == 0
        assert run.status == "pending"
        if lost == "replaced":
            assert run.lease_token == "replacement-lease"
