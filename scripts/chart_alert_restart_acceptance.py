"""Recreate only this task API container; verify proxy DNS and durable alert state."""

import argparse
import json
import shlex
import subprocess
import time
import uuid
from pathlib import Path

import httpx
from alerts.storage import ChartAlert, ChartAlertVersion, Notification, Outbox, SignalRow
from sqlalchemy import create_engine, select
from sqlalchemy.engine import make_url

ROOT = Path("/tmp/mw-chart-alerts-acceptance")
COMPOSE = Path(__file__).resolve().parents[1] / "docs/verification/chart-alerts/compose.yaml"
PROJECT = "mw-chart-alerts-acceptance"


def docker(*args):
    return (
        subprocess.run(
            ["sg", "docker", "-c", shlex.join(["docker", *args])],
            check=True,
            capture_output=True,
            timeout=60,
        )
        .stdout.decode()
        .strip()
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database-host", required=True)
    parser.add_argument("--force-ip-change", action="store_true")
    args = parser.parse_args()
    values = dict(
        line.split("=", 1) for line in (ROOT / "api.env").read_text().splitlines() if "=" in line
    )
    url = make_url(values["ALERTS_DATABASE_URL"]).set(host=args.database_host)
    if url.database != "chart_alerts_acceptance" or url.username != "chart_alerts_acceptance":
        raise ValueError("Only dedicated acceptance DB allowed")
    engine = create_engine(url)

    def snapshot():
        with engine.connect() as c:
            return {
                "rules": {
                    r.id: (r.run, r.version, r.count, r.status)
                    for r in c.execute(
                        select(
                            ChartAlert.id,
                            ChartAlert.run,
                            ChartAlert.version,
                            ChartAlert.count,
                            ChartAlert.status,
                        )
                    )
                },
                "versions": list(
                    c.execute(
                        select(ChartAlertVersion.__table__).order_by(ChartAlertVersion.id)
                    ).mappings()
                ),
                "events": list(
                    c.execute(select(SignalRow.__table__).order_by(SignalRow.id)).mappings()
                ),
                "notes": list(
                    c.execute(select(Notification.__table__).order_by(Notification.id)).mappings()
                ),
                "outbox": list(c.execute(select(Outbox.__table__).order_by(Outbox.id)).mappings()),
            }

    old_container = docker("inspect", "--format", "{{.Id}}", PROJECT + "-api-1")
    old_ip = docker(
        "inspect",
        "--format",
        '{{(index .NetworkSettings.Networks "' + PROJECT + '_default").IPAddress}}',
        PROJECT + "-api-1",
    )
    before = snapshot()
    started = time.monotonic()
    holder = PROJECT + "-ip-reservation-" + uuid.uuid4().hex[:8]
    held = False
    disconnected = False
    recreated = False
    try:
        if args.force_ip_change:
            assert (
                docker(
                    "inspect",
                    "--format",
                    '{{index .Config.Labels "com.docker.compose.project"}}',
                    PROJECT + "-api-1",
                )
                == PROJECT
            )
            docker("network", "disconnect", PROJECT + "_default", PROJECT + "-api-1")
            disconnected = True
            docker(
                "run",
                "-d",
                "--name",
                holder,
                "--network",
                PROJECT + "_default",
                "--ip",
                old_ip,
                "--label",
                "com.docker.compose.project=" + PROJECT,
                "--entrypoint",
                "sleep",
                "market-watch-api:chart-alerts-acceptance",
                "120",
            )
            held = True
        docker(
            "compose",
            "--env-file",
            str(ROOT / "compose.env"),
            "-p",
            PROJECT,
            "-f",
            str(COMPOSE),
            "up",
            "-d",
            "--force-recreate",
            "--no-deps",
            "api",
        )
        recreated = True
    finally:
        if held:
            docker("rm", "-f", holder)
        if disconnected and not recreated:
            docker("network", "connect", PROJECT + "_default", PROJECT + "-api-1")
    new_container = docker("inspect", "--format", "{{.Id}}", PROJECT + "-api-1")
    new_ip = docker(
        "inspect",
        "--format",
        '{{(index .NetworkSettings.Networks "' + PROJECT + '_default").IPAddress}}',
        PROJECT + "-api-1",
    )
    assert new_container != old_container
    if args.force_ip_change:
        assert new_ip != old_ip
    with httpx.Client(
        base_url="https://localhost:19443", verify=False, trust_env=False, timeout=5
    ) as client:
        while time.monotonic() - started < 60:
            try:
                if client.get("/readyz").status_code == 200:
                    break
            except httpx.HTTPError:
                pass
            time.sleep(0.5)
        else:
            raise AssertionError("API proxy never recovered after task container recreation")
        response = client.post("/api/login", json=json.loads((ROOT / "login.json").read_text()))
        response.raise_for_status()
    after = snapshot()
    assert after == before, (
        "Rule counts, versions, events, notifications, or queues changed across restart"
    )
    engine.dispose()
    result = {
        "verified": True,
        "container_recreated": True,
        "api_ip_changed": old_ip != new_ip,
        "web_restarted": False,
        "proxy_and_https_login_recovered": True,
        "durable_configuration_counts_and_records_preserved": True,
        "runtime_checkpoints_excluded_because_worker_continues": True,
        "rule_count": len(after["rules"]),
        "event_count": len(after["events"]),
        "recovery_seconds": round(time.monotonic() - started, 2),
    }
    (ROOT / "restart-acceptance.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
