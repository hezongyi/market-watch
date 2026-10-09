"""Switch only the owned Ubuntu acceptance project; keep credentials private."""
import argparse
import json
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TASK = "mw-unified-sse-20261008"
DIRECTORY = ROOT / "artifacts/unified-sse"
ENV = DIRECTORY / "acceptance.env"
BACKUP = DIRECTORY / "account-switch-original.env"
SERVICES = ("api", "api-second", "market-stream-worker", "composite-aggregate-worker",
    "realtime-worker", "history-worker", "native-history-worker", "provider-history-worker",
    "chart-aggregation-worker", "pricing-worker")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("switch", "restore"))
    args = parser.parse_args()
    if "ID=ubuntu" not in Path("/etc/os-release").read_text().splitlines():
        raise SystemExit("Ubuntu required")
    if os.getenv("DOCKER_HOST", "unix:///var/run/docker.sock") != "unix:///var/run/docker.sock":
        raise SystemExit("Local Docker required")
    compose = ["docker", "compose", "--env-file", str(DIRECTORY / "compose.env"),
        "-p", TASK, "-f", str(ROOT / "compose.unified-sse.acceptance.yaml"), "--profile", "upstream"]
    for service in SERVICES:
        value = json.loads(subprocess.check_output(["docker", "inspect", f"{TASK}-{service}-1"]))[0]
        if value["Config"]["Labels"].get("com.docker.compose.project") != TASK:
            raise SystemExit("Container ownership mismatch")
    if args.action == "switch":
        if BACKUP.exists():
            raise SystemExit("Restore the pending switch before running again")
        original = ENV.read_text()
        lines = original.splitlines(keepends=True)
        index = next(i for i, line in enumerate(lines) if line.startswith("ALERTS_OANDA_ACCOUNT_ID="))
        current = lines[index].split("=", 1)[1].strip().strip("\"'")
        accounts = json.loads((DIRECTORY / "oanda-accessible-accounts.json").read_text())
        alternate = next(account for account in accounts if account != current)
        if not all(c.isdigit() or c == "-" for c in alternate):
            raise SystemExit("Invalid account record")
        with BACKUP.open("x") as stream:
            os.chmod(BACKUP, 0o600)
            stream.write(original)
        lines[index] = "ALERTS_OANDA_ACCOUNT_ID=" + alternate + "\n"
        ENV.write_text("".join(lines))
    else:
        if not BACKUP.exists():
            raise SystemExit("No pending account switch")
        ENV.write_bytes(BACKUP.read_bytes())
    os.chmod(ENV, 0o600)
    result = subprocess.run([*compose, "up", "-d", "--no-build", "--no-deps",
        "--force-recreate", *SERVICES], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        raise SystemExit("Owned Compose recreation failed; private backup retained for restore")
    if args.action == "restore":
        BACKUP.unlink()
    print(json.dumps({"action": args.action, "project": TASK, "recreated": list(SERVICES)}))


if __name__ == "__main__":
    main()
