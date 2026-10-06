"""Acceptance failures recover only their configured, task-owned resources."""

import importlib.util
import runpy
import subprocess
import sys
import types
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"


def environment(monkeypatch, tmp_path):
    module = types.ModuleType("chart_alert_acceptance_environment")
    module.APP = "https://localhost:19543"
    module.DATABASE = "chart_alerts_integration"
    module.ROOT = tmp_path
    module.PROJECT = "mw-chart-alerts-integration"
    module.COMPOSE = SCRIPTS / "unused-compose.yaml"
    monkeypatch.setitem(sys.modules, module.__name__, module)


def test_certificate_failure_can_be_retried_without_changing_credentials(monkeypatch, tmp_path):
    environment(monkeypatch, tmp_path)
    real_run = subprocess.run

    def fail_certificate(*args, **options):
        raise subprocess.CalledProcessError(1, args[0])

    monkeypatch.setattr(subprocess, "run", fail_certificate)
    script = str(SCRIPTS / "prepare_chart_alert_acceptance.py")
    with pytest.raises(subprocess.CalledProcessError):
        runpy.run_path(script)
    credentials = {name: (tmp_path / name).read_bytes()
                   for name in ("api.env", "login.json", "compose.env")}
    assert all((tmp_path / name).stat().st_mode & 0o777 == 0o600 for name in credentials)
    monkeypatch.setattr(subprocess, "run", real_run)
    runpy.run_path(script)
    assert credentials == {name: (tmp_path / name).read_bytes() for name in credentials}
    certificate = (tmp_path / "cert.pem").read_bytes()
    runpy.run_path(script)
    assert (tmp_path / "cert.pem").read_bytes() == certificate


def test_stop_timeout_still_attempts_api_restart(monkeypatch, tmp_path):
    environment(monkeypatch, tmp_path)
    spec = importlib.util.spec_from_file_location("fault_recovery", SCRIPTS / "chart_alert_fault_acceptance.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    calls = []

    def compose(*args):
        calls.append(args)
        if args[0] == "stop":
            raise subprocess.TimeoutExpired("task stop", 60)

    monkeypatch.setattr(module, "compose", compose)
    with pytest.raises(subprocess.TimeoutExpired), module.paused_api():
        pytest.fail("stop timeout must not enter the data mutation block")
    assert calls == [("stop", "api"), ("start", "api")]
