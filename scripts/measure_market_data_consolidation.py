"""Fixed-input replay against v2.0.9 functions; no supplier/network calls.

Run from the task worktree with PYTHONPATH=backend:backend/tests and its Python
requirements. Results are development measurements, not live idle-CPU claims.
"""

import ast
import json
import statistics
import subprocess
import time
import tracemalloc
from datetime import date, timedelta

from alerts import native_history_archive as archive
from alerts import provider_display_snapshots as snapshots
from alerts import storage
from alerts.history_artifacts import artifact_tick
from alerts.history_maintenance import create_run
from alerts.history_versions import import_page
from alerts.source_history_store import raw_chunk
from alerts.storage import HistoryChunk, HistoryFrameRun, HistoryVersion, Preference
from sqlalchemy import create_engine, delete, event, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from test_native_history_archive import Adapter, day, prepare, stamp

BASELINE = "eaacf47ef86b082f7a80b81841366dc1aa8908e4"


def baseline_function(module, filename, name):
    source = subprocess.check_output(["git", "show", BASELINE + ":backend/alerts/" + filename], text=True)
    definition = next(item for item in ast.parse(source).body if isinstance(item, ast.FunctionDef) and item.name == name)
    namespace = dict(vars(module))
    exec(compile(ast.Module(body=[definition], type_ignores=[]), filename, "exec"), namespace)
    return namespace[name]


def measured(job):
    statements = []
    def observe(*args):
        statements.append(args[2])
    event.listen(engine, "before_cursor_execute", observe)
    tracemalloc.start()
    cpu, wall = time.process_time(), time.perf_counter()
    try:
        result = job()
        cpu, wall = time.process_time() - cpu, time.perf_counter() - wall
        _, peak = tracemalloc.get_traced_memory()
        return result, {"cpu_seconds": cpu, "wall_seconds": wall, "peak_mib": peak / 1024 ** 2, "sql": len(statements)}
    finally:
        tracemalloc.stop()
        event.remove(engine, "before_cursor_execute", observe)


def median(values):
    return {key: round(statistics.median(row[key] for row in values), 5) for key in values[0]}


engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
storage.bootstrap(engine)
factory = sessionmaker(engine, expire_on_commit=False)
storage.Session = factory
old_merge = baseline_function(archive, "native_history_archive.py", "_merge")
old_publish = baseline_function(snapshots, "provider_display_snapshots.py", "publish")
dataset = prepare(factory, mode="native_periods", outputs=("D1",), start="2015-01-01")
days = [day((date(2015, 1, 1) + timedelta(days=i)).isoformat()) for i in range((date(2026, 1, 1) - date(2015, 1, 1)).days)]
with factory.begin() as db:
    parent = create_run(db, dataset, end=stamp("2026-01-01"), request_id="parent").id
for _ in range(30):
    if not import_page(Adapter({"D1": days}), version_id=parent):
        break
else:
    raise AssertionError("parent failed to publish")
for _ in range(10000):
    if not artifact_tick(parent):
        break
else:
    raise AssertionError("parent artifacts failed to finish")
with factory.begin() as db:
    candidate = create_run(db, dataset, end=stamp("2026-01-02"), request_id="benchmark").id
assert import_page(Adapter({"D1": [*days, day("2026-01-01")]}), version_id=candidate)
merges = {"baseline": [], "candidate": []}
expected = None
for _ in range(3):
    for label, function in (("baseline", old_merge), ("candidate", archive._merge)):
        def merge():
            with factory.begin() as db:
                version = db.get(HistoryVersion, candidate)
                frame = db.get(HistoryFrameRun, (candidate, "D1"))
                savepoint = db.begin_nested()
                try:
                    facts = function(db, version, frame)
                    db.flush()
                    contents = [json.loads(raw_chunk(db, row)) for row in db.scalars(select(HistoryChunk).where(
                        HistoryChunk.version_id == candidate).order_by(HistoryChunk.start))]
                    return facts, contents
                finally:
                    savepoint.rollback()
        decoded = []
        reader = function.__globals__["_rows_from_pages"]
        def counted(db, frame):
            decoded.extend(frame.facts.get("pages", []))
            yield from reader(db, frame)
        function.__globals__["_rows_from_pages"] = counted
        try:
            result, evidence = measured(merge)
        finally:
            function.__globals__["_rows_from_pages"] = reader
        evidence["checkpoint_page_decodes"] = len(decoded)
        if expected is None:
            expected = result
        assert result == expected
        merges[label].append(evidence)

publications = {"baseline": [], "candidate": []}
for iteration in range(3):
    for label, function in (("baseline", old_publish), ("candidate", snapshots.publish)):
        clock = storage.now_ms()
        with factory.begin() as db:
            db.execute(delete(Preference).where(Preference.key.startswith(snapshots.PREFIX)))
            db.add_all([Preference(key=snapshots.PREFIX + str(i), value={"expires": clock + snapshots.LEASE_MS,
                "content": {"fixture": "x" * 4096}}) for i in range(snapshots.MAX_SNAPSHOTS)])
        _, evidence = measured(lambda: function({"provider_snapshot_id": f"new-{iteration}",
            "_provider_snapshot": {"fixture": "new"}}))
        publications[label].append(evidence)
        with factory() as db:
            assert len(list(db.scalars(select(Preference.key).where(
                Preference.key.startswith(snapshots.PREFIX))))) == snapshots.MAX_SNAPSHOTS
print(json.dumps({"baseline_commit": BASELINE, "backend": "isolated in-memory SQLite, fixed inputs, tracemalloc enabled",
    "native_history": {"source_days": len(days), "months": 133, "identical_rows_and_facts": True,
        **{label: median(values) for label, values in merges.items()}},
    "snapshot_publish": {"existing_snapshots": snapshots.MAX_SNAPSHOTS, "payload_bytes_each": 4096,
        **{label: median(values) for label, values in publications.items()}}}, indent=2))
engine.dispose()
