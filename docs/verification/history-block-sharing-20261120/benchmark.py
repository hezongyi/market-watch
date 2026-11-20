"""Controlled materialization/read benchmark; isolated PostgreSQL schemas only.

Run in the task container with TEST_POSTGRES_URL pointing to the isolated test
PostgreSQL. Uses repository fixture adapters; no real supplier or user data.
"""

import hashlib
import json
import os
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "backend/tests"))
from sqlalchemy import create_engine, event, func, select, text
from sqlalchemy.orm import sessionmaker

from alerts import storage
from alerts.config import settings
from alerts.history_artifacts import artifact_tick, iter_artifact
from alerts.history_maintenance import configure, create_run
from alerts.history_versions import import_page
from alerts.storage import HistoryArtifact, HistoryArtifactBlock
from test_history_maintenance import Adapter
from test_market_contracts import identity
from test_market_datasets import register

FRAMES = ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN"]


def materialize(vid):
    for _ in range(2000):
        if not artifact_tick(vid):
            return
    raise AssertionError("materialization did not converge")


def run(sharing, legacy=False):
    admin = create_engine(os.environ["TEST_POSTGRES_URL"])
    schema = "sharing_bench_" + uuid.uuid4().hex
    with admin.begin() as c:
        c.execute(text(f"CREATE SCHEMA {schema}"))
    engine = create_engine(
        os.environ["TEST_POSTGRES_URL"], connect_args={"options": f"-csearch_path={schema}"}
    )
    storage.Base.metadata.create_all(engine)
    storage.Session = sessionmaker(engine, expire_on_commit=False)
    settings.history_block_sharing_enabled = sharing
    stats = {"sql": 0, "payload_selects": 0, "compression_calls": 0, "decompression_calls": 0}

    def counted(c, cur, statement, params, ctx, many):
        stats["sql"] += 1
        if "SELECT" in statement.upper() and "market_history_artifact_blocks.content" in statement:
            stats["payload_selects"] += 1

    event.listen(engine, "before_cursor_execute", counted)
    import alerts.history_artifacts as artifacts

    compress, decompress = artifacts.gzip.compress, artifacts.gzip.decompress

    def tracked_compress(*a, **kw):
        stats["compression_calls"] += 1
        return compress(*a, **kw)

    def tracked_decompress(*a, **kw):
        stats["decompression_calls"] += 1
        return decompress(*a, **kw)

    artifacts.gzip.compress = tracked_compress
    artifacts.gzip.decompress = tracked_decompress
    try:
        end = 60001 * 60000
        with storage.Session.begin() as db:
            register(db)
            configure(db, identity().key, target_start=0, timeframes=FRAMES, overlap_minutes=2)
            parent = create_run(db, identity().key, end=end, request_id="parent").id
        while import_page(Adapter(), version_id=parent):
            pass
        materialize(parent)
        if legacy:
            with engine.begin() as c:
                c.execute(
                    text(
                        "UPDATE market_history_artifact_blocks SET input_count=NULL,complete_count=NULL"
                    )
                )
        results = []
        for generation in range(2):
            with storage.Session.begin() as db:
                child = create_run(
                    db,
                    identity().key,
                    end=end + (generation + 1) * 60000,
                    request_id=f"update-{generation}",
                ).id
            while import_page(Adapter(close="1.10"), version_id=child):
                pass
            for key in stats:
                stats[key] = 0
            started = time.monotonic()
            materialize(child)
            elapsed = time.monotonic() - started
            work = dict(stats)
            with storage.Session.begin() as db:
                block_stats = db.execute(
                    select(
                        func.count(),
                        func.coalesce(func.sum(func.length(HistoryArtifactBlock.content)), 0),
                        func.count(HistoryArtifactBlock.source_block_id),
                    )
                    .join(HistoryArtifact)
                    .where(HistoryArtifact.version_id == child)
                ).one()
            for key in stats:
                stats[key] = 0
            started = time.monotonic()
            digest = hashlib.sha256()
            bars = 0
            with storage.Session.begin() as db:
                for frame in FRAMES:
                    for row in iter_artifact(db, child, frame):
                        digest.update(
                            json.dumps(
                                {k: v for k, v in row.items() if k != "parent_version_id"},
                                sort_keys=True,
                            ).encode()
                        )
                        bars += 1
            results.append(
                dict(
                    generation=generation + 1,
                    seconds=elapsed,
                    work=work,
                    read_seconds=time.monotonic() - started,
                    read_sql=stats["sql"],
                    bars=bars,
                    digest=digest.hexdigest(),
                    blocks=block_stats[0],
                    new_payload_bytes=block_stats[1],
                    shared_blocks=block_stats[2],
                )
            )
        return dict(sharing=sharing, legacy=legacy, results=results)
    finally:
        artifacts.gzip.compress = compress
        artifacts.gzip.decompress = decompress
        engine.dispose()
        with admin.begin() as c:
            c.execute(text(f"DROP SCHEMA {schema} CASCADE"))
        admin.dispose()


if __name__ == "__main__":
    rows = []
    for args in [(False, False), (True, False), (True, True)]:
        result = run(*args)
        rows.append(result)
        print(json.dumps(result), flush=True)
    for index in range(2):
        expected = rows[0]["results"][index]
        for row in rows[1:]:
            actual = row["results"][index]
            assert actual["digest"] == expected["digest"] and actual["bars"] == expected["bars"]
    assert (
        rows[1]["results"][1]["new_payload_bytes"] < rows[0]["results"][1]["new_payload_bytes"] / 4
    )
