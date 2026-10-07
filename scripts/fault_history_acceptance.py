"""Interrupt only this project's real history worker and verify durable continuation."""

import argparse
import hashlib
import json
import shlex
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COMPOSE = ["docker", "compose", "--env-file", "artifacts/data-integration/compose.env",
           "-p", "market-watch-data-integration", "-f", "docs/verification/data-integration/compose.yaml"]

PROBE = '''
import hashlib,json
from alerts.storage import HistoryVersion,HistoryChunk,now_ms,transaction
from sqlalchemy import select,text
result=[]
with transaction() as db:
 db.execute(text('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'))
 for v in db.scalars(select(HistoryVersion).where(HistoryVersion.end-HistoryVersion.start>9*365*86400000)):
  cursor=v.start;count=0;rows=0;prefix=[]
  for c in db.execute(select(HistoryChunk.id,HistoryChunk.start,HistoryChunk.end,HistoryChunk.checksum,HistoryChunk.count).where(HistoryChunk.version_id==v.id).order_by(HistoryChunk.start).execution_options(yield_per=100)):
   assert c.start==cursor and c.end>cursor
   cursor=c.end;count+=1;rows+=c.count
   prefix.append([c.id,c.start,c.end,c.checksum])
  assert cursor==v.cursor
  result.append({'id':v.id,'cursor':v.cursor,'end':v.end,'status':v.status,'lease_until':v.lease_until,
                 'chunks':count,'rows':rows,'prefix':prefix})
print(json.dumps({'at':now_ms(),'versions':result}))
'''


def command(arguments, *, data=None):
    return subprocess.run(["sg", "docker", "-c", shlex.join(COMPOSE + arguments)], cwd=ROOT,
                          input=data, capture_output=True, timeout=90, check=True).stdout


def probe():
    return json.loads(command(["exec", "-T", "api", "python", "-"], data=PROBE.encode()))


def compact(sample):
    return {"at": sample["at"], "versions": [
        {key: row[key] for key in ("id", "cursor", "status", "chunks", "rows", "lease_until")}
        | {"chunk_prefix_sha256": hashlib.sha256(json.dumps(row["prefix"]).encode()).hexdigest()}
        for row in sample["versions"]]}


def main(crash=False):
    result = {"host": "Ubuntu local Docker", "project": "market-watch-data-integration",
              "fault": "real history worker SIGKILL" if crash else "real history worker process restart",
              "passed": False}
    before = probe()
    if len(before["versions"]) != 2 or all(row["status"] == "published" for row in before["versions"]):
        raise RuntimeError("Two unfinished ten-year tasks are needed to verify continuation")
    result["before"] = compact(before)
    stopped = False
    paused = False
    try:
        if crash:
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                command(["pause", "history-worker"])
                paused = True
                frozen = probe()
                if any(row["status"] == "running" and row["lease_until"] > frozen["at"]
                       for row in frozen["versions"]):
                    result["frozen_before_crash"] = compact(frozen)
                    result["in_flight_task_frozen_before_kill"] = True
                    break
                command(["unpause", "history-worker"])
                paused = False
                time.sleep(1)
            else:
                raise RuntimeError("No in-flight history task could be frozen before the crash")
        command(["kill", "--signal", "SIGKILL", "history-worker"] if crash else ["stop", "history-worker"])
        paused = False
        stopped = True
        halted = probe()
        result["halted"] = compact(halted)
        baselines = {row["id"]: row for row in halted["versions"]}
        # Stop may commit an in-flight page. Only the durable halted checkpoint
        # is authoritative; the earlier sampled cursor is not a rollback target.
        command(["start", "history-worker"])
        stopped = False
        resumed = time.monotonic()
        deadline = resumed + 150
        while time.monotonic() < deadline:
            after = probe()
            for row in after["versions"]:
                previous = baselines[row["id"]]
                if row["cursor"] < previous["cursor"] or row["prefix"][:len(previous["prefix"])] != (
                        previous["prefix"]):
                    raise RuntimeError("Worker restart regressed a checkpoint or rewrote committed original chunks")
            if all(row["cursor"] > baselines[row["id"]]["cursor"] or row["status"] == "published"
                   for row in after["versions"]):
                result["after"] = compact(after)
                result["resume_seconds"] = round(time.monotonic() - resumed, 3)
                result["passed"] = True
                break
            time.sleep(5)
        else:
            raise RuntimeError("Both ten-year tasks did not resume within their bounded lease window")
    finally:
        if paused:
            command(["unpause", "history-worker"])
        if stopped:
            command(["start", "history-worker"])
        result["finished_at"] = int(time.time() * 1000)
        name = "history-worker-crash.json" if crash else "history-worker-restart.json"
        (ROOT / "docs/verification/data-integration" / name).write_text(
            json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--crash", action="store_true")
    main(parser.parse_args().crash)
