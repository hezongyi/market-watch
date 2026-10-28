import os
import signal
import subprocess
import sys
import threading
from pathlib import Path

import pytest
from alerts.runtime_supervisor import (
    Loop,
    RuntimeGroupError,
    UnstoppedThreads,
    run_group,
    run_steps,
    signal_stops,
)


def test_simple_step_loop_reports_idle_checks_and_interrupts_wait():
    stop = threading.Event()
    cycles = []

    def report(**cycle):
        cycles.append(cycle)

    timer = threading.Thread(target=lambda: (threading.Event().wait(.03), stop.set()))
    timer.start()
    run_steps(lambda: False, stop, idle_wait=30, on_cycle=report)
    timer.join(1)

    assert not timer.is_alive()
    assert len(cycles) == 1
    assert all(cycle["finished"] >= cycle["started"] for cycle in cycles)


def test_data_profile_assembles_provider_and_data_roles_without_duplicate_stream(monkeypatch):
    from alerts import data_runtime, provider_capabilities

    expected_sources = ("oanda", "binance")
    monkeypatch.setattr(provider_capabilities, "enabled_sources", lambda: expected_sources)
    loops = data_runtime.build_loops()

    roles = [loop.role for loop in loops]
    assert len(roles) == len(set(roles))
    assert roles == [
        "provider_live_oanda", "provider_warm_oanda",
        "provider_live_binance", "provider_warm_binance",
        "provider_transport_oanda", "provider_transport_binance", "provider_transport_dukascopy",
        "provider_janitor", "chart_history", "history_network", "history_compute",
        "native_history", "chart_aggregation", "market_stream",
        "switch_shadow", "retention",
    ]


def test_complex_run_stop_interface_closes_resources():
    entered, closed, stop = threading.Event(), threading.Event(), threading.Event()

    def complex_run(stop):
        entered.set()
        try:
            stop.wait()
        finally:
            closed.set()

    thread = threading.Thread(target=lambda: run_group(
        [Loop("history", complex_run)], stop=stop, handle_signals=False))
    thread.start()
    assert entered.wait(2)
    stop.set()
    thread.join(2)

    assert not thread.is_alive()
    assert closed.is_set()


def test_existing_alert_monitor_runs_as_a_supervised_complex_loop(monkeypatch):
    from alerts import alert_monitor, chart_alert_worker

    turns = []
    monkeypatch.setattr(chart_alert_worker, "step", lambda **_kwargs: None)

    def run(stop):
        def on_turn(turn):
            turns.append(turn)
            if len(turns) == 2:
                stop.set()

        alert_monitor.run(stop, period=.01, report_health=lambda *_args, **_kwargs: None,
                          on_turn=on_turn)

    run_group([Loop("chart_alert", run)], handle_signals=False)

    assert len(turns) == 2
    assert all(not turn["error"] for turn in turns)


def test_critical_exception_stops_siblings_and_reports_failure():
    states = []
    sibling_stopped = threading.Event()

    def broken(_stop):
        raise ValueError("broken loop")

    def sibling(stop):
        stop.wait()
        sibling_stopped.set()

    with pytest.raises(RuntimeGroupError, match="broken: ValueError"):
        run_group([Loop("broken", broken), Loop("sibling", sibling)],
                  on_state=lambda role, state, error: states.append((role, state)),
                  handle_signals=False)

    assert sibling_stopped.is_set()
    assert ("broken", "failed") in states
    assert ("sibling", "stopped") in states


def test_critical_loop_return_before_stop_fails_group():
    with pytest.raises(RuntimeGroupError, match="one_shot: RuntimeError"):
        run_group([Loop("one_shot", lambda _stop: None)], handle_signals=False)


def test_pre_stopped_group_does_not_start_loops():
    stop = threading.Event()
    stop.set()
    started = []

    run_group([Loop("already_stopped", lambda _stop: started.append(True))],
              stop=stop, handle_signals=False)

    assert started == []


def test_step_loop_rejects_unbounded_wait_configuration():
    with pytest.raises(ValueError, match="positive"):
        run_steps(lambda: False, threading.Event(), idle_wait=0)


def test_signal_handler_sets_stop_and_restores_previous_handler():
    stop = threading.Event()
    signum = signal.SIGUSR1
    previous = signal.getsignal(signum)
    with signal_stops(stop, signals=(signum,)):
        signal.getsignal(signum)(signum, None)
        assert stop.is_set()
    assert signal.getsignal(signum) is previous


def test_supervised_worker_failure_exits_subprocess_nonzero():
    code = """from alerts.runtime_supervisor import Loop, run_group
def fail(_stop):
    raise ValueError('private details')
run_group([Loop('fatal', fail)], handle_signals=False)
"""
    root = Path(__file__).resolve().parents[2]
    env = {**os.environ, "PYTHONPATH": str(root / "backend")}
    result = subprocess.run([sys.executable, "-c", code], cwd=root, env=env,
                            capture_output=True, text=True, timeout=10)
    assert result.returncode != 0
    assert "RuntimeGroupError" in result.stderr
    assert "private details" not in result.stderr


def test_runtime_cli_exits_even_if_a_sibling_cannot_stop():
    code = """import sys, threading
from alerts import runtime
from alerts.runtime_supervisor import Loop, run_group
def broken(_stop):
    raise ValueError('private details')
def stuck(_stop):
    threading.Event().wait()
def run(*_args, **_kwargs):
    run_group([Loop('broken', broken), Loop('stuck', stuck)],
              join_timeout=.05, handle_signals=False)
runtime.market_runtime.run = run
sys.argv = ['runtime', '--profile', 'market']
runtime.main()
"""
    root = Path(__file__).resolve().parents[2]
    result = subprocess.run([sys.executable, "-c", code], cwd=root,
        env={**os.environ, "PYTHONPATH": str(root / "backend")},
        capture_output=True, text=True, timeout=10)
    assert result.returncode == 1
    assert "stuck: did not stop" in result.stderr
    assert "private details" not in result.stderr


def test_nested_threads_still_using_resources_make_group_shutdown_fail():
    release = threading.Event()
    nested = threading.Thread(target=release.wait, name="confirmation")
    nested.start()
    try:
        def failed_shutdown(_stop):
            raise UnstoppedThreads((nested,))

        with pytest.raises(RuntimeGroupError) as result:
            run_group([Loop("pricing", failed_shutdown)], handle_signals=False)
        assert result.value.alive == ("confirmation",)
    finally:
        release.set()
        nested.join(2)
