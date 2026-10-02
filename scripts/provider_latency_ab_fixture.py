"""Recreate only the isolated provider-fix API with a pinned baseline/fix image."""

import argparse
import json
import os
import shlex
import subprocess
import time
from pathlib import Path

import httpx


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("arm", choices=["baseline", "fix"])
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    directory = Path("/tmp/mw-provider-latency/ab-stats")
    design = json.loads((root / "docs/verification/provider-latency/ab-statistics/design.json").read_text())
    image = design["images"][args.arm]["image_id"]
    override = directory / "override.yaml"
    override.write_text("services:\n  api:\n    image: " + image + "\n")
    compose = ["docker", "compose", "-f", "/tmp/mw-provider-latency/compose.yaml",
               "-f", str(override)]

    def docker(*args):
        result = subprocess.run(["sg", "docker", "-c", shlex.join([*compose, *args])],
                                capture_output=True, timeout=75)
        if result.returncode:
            raise RuntimeError("Isolated fixture lifecycle command failed")

    docker("stop", "api")
    reset = subprocess.run(
        [str(root / ".venv/bin/python"), str(root / "scripts/provider_acceptance_fixture.py"),
         "--profile", "provider-fix", "--reset"],
        cwd=root, env=os.environ | {"PYTHONPATH": str(root / "backend")},
        capture_output=True, timeout=45,
    )
    if reset.returncode:
        raise RuntimeError("Isolated provider cache reset failed")
    docker("up", "-d", "--force-recreate", "api")
    deadline = time.monotonic() + 60
    with httpx.Client(trust_env=False, timeout=2) as client:
        while time.monotonic() < deadline:
            try:
                response = client.get("http://127.0.0.1:18063/readyz")
                if response.status_code == 200:
                    print(json.dumps({"arm": args.arm, "image_id": image, "ready": True}))
                    return
            except httpx.HTTPError:
                pass
            time.sleep(0.2)
    raise RuntimeError("Isolated API did not become ready")


if __name__ == "__main__":
    main()
