"""Read-only resource samples for the exact Ubuntu acceptance project.

Run under the local Docker group. Compare equal-duration scenarios with equal
input rates; a scenario label alone does not establish a baseline comparison.
"""

import argparse
import http.client
import json
import os
import socket
import subprocess
import time
from pathlib import Path

TASK = "mw-unified-sse-20261008"
SERVICES = ("api", "api-second", "market-stream-worker", "postgres", "web",
            "web-second", "chart-origin", "composite-aggregate-worker",
            "history-worker", "native-history-worker", "chart-aggregation-worker", "realtime-worker")


class LocalDocker(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect("/var/run/docker.sock")


def docker_json(endpoint):
    connection = LocalDocker("localhost", timeout=15)
    try:
        connection.request("GET", endpoint)
        response = connection.getresponse()
        if response.status != 200:
            raise RuntimeError(f"Docker read failed: {endpoint}: {response.status}")
        return json.loads(response.read())
    finally:
        connection.close()


def database(container):
    sql = """SELECT json_build_object(
      'at',clock_timestamp(), 'database_bytes',pg_database_size(current_database()),
      'wal',(SELECT row_to_json(w) FROM pg_stat_wal w),
      'stream_queue',json_build_object(
        'tasks',(SELECT count(*) FROM market_stream_tasks),
        'active_subscriptions',(SELECT count(*) FROM market_stream_subscriptions
          WHERE active AND expires>extract(epoch FROM clock_timestamp())*1000),
        'retained_results',(SELECT count(*) FROM market_stream_results)),
      'activity',(SELECT row_to_json(d) FROM pg_stat_database d WHERE datname=current_database()),
      'tables',(SELECT json_agg(t) FROM (SELECT relname,seq_scan,seq_tup_read,idx_scan,
        idx_tup_fetch,n_tup_ins,n_tup_upd,n_tup_del,n_live_tup,n_dead_tup,
        pg_total_relation_size(relid) AS bytes FROM pg_stat_user_tables
        WHERE schemaname='public' AND relname LIKE 'market_stream_%' ORDER BY relname) t))"""
    output = subprocess.check_output(["docker", "exec", container, "psql", "-U", "alerts",
        "-d", "alerts", "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql], timeout=20)
    return json.loads(output)


def snapshot(containers):
    rows = {}
    for service, container in containers.items():
        value = docker_json(f"/containers/{container['Id']}/stats?stream=false&one-shot=true")
        memory = value["memory_stats"]
        networks = value.get("networks", {}).values()
        rows[service] = {
            "sample_at": time.time(),
            "cpu_seconds": value["cpu_stats"]["cpu_usage"]["total_usage"] / 1e9,
            "memory_bytes": memory.get("usage", 0),
            "working_set_bytes": max(0, memory.get("usage", 0) -
                                     memory.get("stats", {}).get("inactive_file", 0)),
            "network_rx_bytes": sum(n["rx_bytes"] for n in networks),
            "network_tx_bytes": sum(n["tx_bytes"] for n in value.get("networks", {}).values()),
            "block_io": value.get("blkio_stats", {}).get("io_service_bytes_recursive"),
        }
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenario", required=True)
    parser.add_argument("--seconds", type=int, default=60)
    parser.add_argument("--interval", type=int, default=5)
    args = parser.parse_args()
    if not 10 <= args.seconds <= 600 or not 1 <= args.interval <= 60:
        parser.error("seconds must be 10..600; interval must be 1..60")
    if not args.scenario or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789-_" for c in args.scenario):
        parser.error("scenario must contain only lowercase letters, numbers, - or _")
    if "ID=ubuntu" not in Path("/etc/os-release").read_text().splitlines():
        raise SystemExit("Ubuntu required")
    if os.getenv("DOCKER_HOST", "unix:///var/run/docker.sock") != "unix:///var/run/docker.sock":
        raise SystemExit("Local Docker socket required")
    containers = {}
    for service in SERVICES:
        item = docker_json(f"/containers/{TASK}-{service}-1/json")
        labels = item["Config"]["Labels"]
        if labels.get("com.docker.compose.project") != TASK or labels.get("com.docker.compose.service") != service:
            raise SystemExit("Container ownership mismatch")
        if item["State"]["Running"]:
            containers[service] = {"Id": item["Id"], "Image": item["Image"]}
    if "postgres" not in containers:
        raise SystemExit("Task PostgreSQL must be running")
    images = {}
    for container in containers.values():
        image_id = container["Image"]
        if image_id not in images:
            item = docker_json(f"/images/{image_id}/json")
            images[image_id] = {"logical_bytes": item["Size"],
                "commit": item["Config"].get("Labels", {}).get("io.market-watch.commit")}
    report = {"project": TASK, "environment": "Ubuntu local Docker", "scenario": args.scenario,
        "requested_seconds": args.seconds, "containers": containers, "images": images,
        "database_before": database(containers["postgres"]["Id"]), "samples": [],
        "limits": ["Image sizes are logical sizes; shared layers cannot be summed as physical disk use.",
                   "Database counters include all activity in this isolated project, including fixture writes.",
                   "This probe does not run or simulate a workload; record the workload separately.",
                   "Container network totals count internal traffic at both ends; do not sum as external bandwidth.",
                   "Browser and host fixture processes are outside these container CPU/memory counters.",
                   "Sparse memory samples may miss brief peaks; block I/O may be unavailable on this host."]}
    report["samples"].append(snapshot(containers))
    started = time.monotonic()
    while time.monotonic() - started < args.seconds:
        time.sleep(min(args.interval, max(0, args.seconds - (time.monotonic() - started))))
        report["samples"].append(snapshot(containers))
    report["database_after"] = database(containers["postgres"]["Id"])
    report["summary"] = {}
    for service in containers:
        rows = [sample[service] for sample in report["samples"]]
        first, last = rows[0], rows[-1]
        elapsed = last["sample_at"] - first["sample_at"]
        report["summary"][service] = {
            "elapsed_seconds": elapsed,
            "cpu_seconds": last["cpu_seconds"] - first["cpu_seconds"],
            "average_cpu_cores": (last["cpu_seconds"] - first["cpu_seconds"]) / elapsed,
            "working_set_average_bytes": sum(r["working_set_bytes"] for r in rows) / len(rows),
            "working_set_peak_bytes": max(r["working_set_bytes"] for r in rows),
            "network_rx_bytes": last["network_rx_bytes"] - first["network_rx_bytes"],
            "network_tx_bytes": last["network_tx_bytes"] - first["network_tx_bytes"],
        }
    directory = Path(__file__).resolve().parents[1] / "artifacts/unified-sse/resources"
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = directory / f"{args.scenario}-{time.time_ns()}.json"
    target.write_text(json.dumps(report, indent=2) + "\n")
    target.chmod(0o600)
    print(json.dumps({"report": str(target), "scenario": args.scenario, "summary": report["summary"]}))


if __name__ == "__main__":
    main()
