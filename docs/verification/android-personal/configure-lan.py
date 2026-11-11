"""Adapt only this newly prepared preview to the user's Ubuntu LAN test address.

Run preview prepare first. Private TLS material stays in task-owned ignored or
private directories; no existing project's CA/key/DB/configuration is reused.
"""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "deploy/ubuntu"))
import mw_docker as manager  # noqa: E402
import mw_preview as preview  # noqa: E402

TASK = "mw-android-personal-v205"
args = argparse.Namespace(task=TASK, project=TASK)
directory, record, _ = preview.load(manager, args)
assert record["repo"] == str(REPO) and record["port"] == 18445 and record["ui"]
running = subprocess.check_output(["docker", "ps", "-q", "--filter", f"label=com.docker.compose.project={TASK}"], text=True)
if running.strip():
    raise SystemExit("Task already running; preserve its current configuration")
tls = REPO / ".tools/dev-tls"
for name in ("cert.pem", "key.pem"):
    shutil.copyfile(tls / name, directory / name)
    os.chmod(directory / name, 0o600 if name == "key.pem" else 0o644)
config = json.loads((directory / "compose.json").read_text())
config["services"]["tls"]["ports"] = ["192.168.7.232:18445:443"]
manager.save(directory / "compose.json", config)
record["url"] = "https://192.168.7.232:18445"
record["files"] = {name: hashlib.sha256((directory / name).read_bytes()).hexdigest()
                   for name in record["files"]}
manager.save(directory / "preview.json", record)
print("Prepared task-owned LAN HTTPS at " + record["url"])
