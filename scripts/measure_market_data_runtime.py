"""Read-only, same-window CPU/workload sampling for the authorized mw-dev."""

import argparse
import concurrent.futures
import datetime
import http.client
import json
import socket
import subprocess
import time
from pathlib import Path


class DockerConnection(http.client.HTTPConnection):
    def __init__(self):
        super().__init__("localhost", timeout=15)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect("/var/run/docker.sock")


def get(path):
    connection = DockerConnection()
    connection.request("GET", path)
    response = connection.getresponse()
    content = response.read()
    connection.close()
    if response.status != 200:
        raise RuntimeError(f"Docker returned {response.status}")
    return json.loads(content)


def stats(container):
    value = get(f"/containers/{container['Id']}/stats?stream=false&one-shot=true")
    return container["Labels"]["com.docker.compose.service"], {
        "cpu_ns": value["cpu_stats"]["cpu_usage"]["total_usage"],
        "at_ns": time.monotonic_ns(),
        "memory_mib": value["memory_stats"].get("usage", 0) / 2**20,
    }


SQL = """BEGIN READ ONLY;
SELECT json_build_object(
 'at',clock_timestamp(),
 'clients',(select count(*) from market_stream_clients where expires > extract(epoch from clock_timestamp())*1000),
 'subscriptions',(select count(*) from market_stream_subscriptions where active and expires > extract(epoch from clock_timestamp())*1000),
 'active_alerts',(select count(*) from chart_alerts where status='active'),
 'history_running',(select count(*) from market_history_versions where status in ('pending','running','retrying')),
 'live',(select coalesce(json_agg(t),'[]') from (select dataset_id,revision,connection,ready,error,received_at,confirmed_end from market_live_states order by dataset_id)t),
 'inputs',(select coalesce(sum(sequence),0) from price_alert_streams),
 'preparations',(select coalesce(json_agg(t),'[]') from (select revision_id,status,input_revision,confirmed_end,error from market_composite_preparations order by revision_id)t),
 'tasks',(select coalesce(json_agg(t),'[]') from (select revision_id,timeframe,applied_input_revision,error,attempts,updated_at from market_composite_aggregate_tasks order by revision_id,timeframe)t),
 'database',(select json_build_object('commits',xact_commit,'read',blks_read,'hit',blks_hit,'inserted',tup_inserted,'updated',tup_updated,'deleted',tup_deleted) from pg_stat_database where datname=current_database()));
ROLLBACK;"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--seconds", type=int, default=90)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    containers = [row for row in get("/containers/json")
                  if row.get("Labels", {}).get("com.docker.compose.project") == "mw-dev"]
    if len(containers) != 8:
        raise RuntimeError("Expected the eight authorized mw-dev containers")
    records = []
    start = time.monotonic()
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        while True:
            cpus = dict(pool.map(stats, containers))
            result = subprocess.check_output(["docker", "exec", "-i", "mw-dev-postgres-1", "psql",
                "-U", "dev", "-d", "dev", "-Atq", "-v", "ON_ERROR_STOP=1"], input=SQL, text=True)
            records.append({"cpu": cpus, "workload": json.loads(result)})
            if time.monotonic() - start >= args.seconds:
                break
            time.sleep(min(15, args.seconds - (time.monotonic() - start)))
    first, last = records[0], records[-1]
    services = {}
    for name, value in last["cpu"].items():
        before = first["cpu"][name]
        cpu_seconds = (value["cpu_ns"] - before["cpu_ns"]) / 1e9
        elapsed = (value["at_ns"] - before["at_ns"]) / 1e9
        services[name] = {"cpu_seconds": round(cpu_seconds, 4),
            "single_core_percent": round(100 * cpu_seconds / elapsed, 3),
            "memory_mib": round(value["memory_mib"], 2)}
    total = sum(row["single_core_percent"] for row in services.values())
    summary = {"host": socket.gethostname(), "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "seconds": round(time.monotonic() - start, 2), "services": services,
        "total_single_core_percent": round(total, 3), "four_core_percent": round(total / 4, 3),
        "input_sequence_delta": last["workload"]["inputs"] - first["workload"]["inputs"],
        "clients": [row["workload"]["clients"] for row in records],
        "history_running": [row["workload"]["history_running"] for row in records]}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({"summary": summary, "records": records}, indent=2) + "\n")
    print(json.dumps(summary), flush=True)


if __name__ == "__main__":
    main()
