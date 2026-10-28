import importlib.util
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "runtime_preflight", ROOT / "deploy/ubuntu/runtime_preflight.py",
)
preflight = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(preflight)


def test_only_live_schedulers_in_explicit_legacy_projects_block_switch():
    containers = "\n".join([
        "a1\told-api\tmarket-watch-v1\tapi",
        "b2\told-db\tmarket-watch-v1\tpostgres",
        "c3\tnew-market\tmarket-watch-v2\tmarket-runtime",
        "d4\tunlisted-old\tother-project\tnotify-worker",
    ])
    assert preflight.conflicts(
        containers, project="market-watch-v2", legacy_projects=["market-watch-v1"],
    ) == [{"id": "a1", "name": "old-api", "project": "market-watch-v1", "service": "api"}]


def test_known_live_scheduler_conflicts_regardless_of_heartbeat_age():
    output = "e5\told-history\tmarket-watch-v1\thistory-worker\nf6\told-projector\tmarket-watch-v1\tprojector"
    assert preflight.conflicts(
        output, project="market-watch-v2", legacy_projects=["market-watch-v1"],
    ) == [
        {"id": "e5", "name": "old-history", "project": "market-watch-v1",
         "service": "history-worker"},
        {"id": "f6", "name": "old-projector", "project": "market-watch-v1",
         "service": "projector"},
    ]


def test_clean_stop_with_residual_heartbeat_does_not_block():
    assert preflight.conflicts(
        "", project="market-watch-v2", legacy_projects=["market-watch-v1"],
    ) == []


def test_cli_blocks_live_conflict_and_queries_only_running_containers(monkeypatch, capsys):
    calls = []

    def run(command, **kwargs):
        calls.append((command, kwargs))
        return subprocess.CompletedProcess(command, 0,
            "a1\told-api\told-project\tapi\n", "")

    monkeypatch.setattr(preflight.subprocess, "run", run)
    assert preflight.main([
        "--project", "new-project", "--legacy-project", "old-project",
    ]) == 1
    assert calls[0][0][:2] == ["docker", "ps"]
    assert calls[0][1]["check"] is True
    assert "old-project/api" in capsys.readouterr().out


def test_cli_fails_closed_when_docker_query_is_unavailable(monkeypatch, capsys):
    def unavailable(*_args, **_kwargs):
        raise subprocess.CalledProcessError(1, "docker ps")

    monkeypatch.setattr(preflight.subprocess, "run", unavailable)
    assert preflight.main([
        "--project", "new-project", "--legacy-project", "old-project",
    ]) == 2
    assert "Preflight inconclusive" in capsys.readouterr().err
