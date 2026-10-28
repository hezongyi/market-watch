#!/usr/bin/env python3
"""Refuse a runtime switch while explicitly named legacy schedulers are alive."""

import argparse
import subprocess
import sys

LEGACY_RUNTIME_SERVICES = frozenset({
    "api",
    "realtime-worker",
    "pricing-worker",
    "alert-runtime",
    "chart-alert-runtime",
    "composite-aggregate-worker",
    "provider-worker",
    "provider-chart-worker",
    "market-stream-worker",
    "history-worker",
    "history-network-worker",
    "history-compute-worker",
    "history-indicator-worker",
    "chart-history-worker",
    "chart-aggregation-worker",
    "native-history-worker",
    "import-worker",
    "legacy-import-worker",
    "projector",
    "notification-projector",
    "notify-worker",
})


def conflicts(output, *, project, legacy_projects):
    legacy_projects = set(legacy_projects) - {project}
    found = []
    for line in output.splitlines():
        fields = line.split("\t", 3)
        if len(fields) != 4:
            continue
        container_id, name, owner, service = fields
        if owner in legacy_projects and service in LEGACY_RUNTIME_SERVICES:
            found.append({"id": container_id, "name": name, "project": owner,
                          "service": service})
    return found


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True, help="new runtime Compose project")
    parser.add_argument("--legacy-project", action="append", required=True,
                        help="verified old Compose project to inspect; repeat as needed")
    args = parser.parse_args(argv)
    if args.project in args.legacy_project:
        parser.error("new project cannot also be listed as a legacy project")
    try:
        result = subprocess.run(
            ["docker", "ps", "--format",
             '{{.ID}}\t{{.Names}}\t{{.Label "com.docker.compose.project"}}\t'
             '{{.Label "com.docker.compose.service"}}'],
            check=True, capture_output=True, text=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        print(f"Preflight inconclusive: Docker query failed ({type(exc).__name__}).",
              file=sys.stderr)
        return 2

    active = conflicts(result.stdout, project=args.project,
                       legacy_projects=args.legacy_project)
    if active:
        print("Runtime switch blocked by live legacy schedulers:")
        for container in active:
            print(f"- {container['project']}/{container['service']} "
                  f"({container['name']}, {container['id'][:12]})")
        return 1
    print("No live legacy scheduler found in the explicitly listed projects.")
    print("Runtime heartbeats are not used as ownership locks by this check.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
