"""Read-only real PostgreSQL mobile search timings and optional query plans.

PYTHONPATH=backend python scripts/mobile_symbol_search_profile.py --rounds 3
Run inside the task API container to use its private connection configuration.
Never prints connection settings, request bodies or account identities.
"""
import argparse
import hashlib
import json
import time

from alerts.history_creation_check import search_catalog
from alerts.instrument_directory import search
from alerts.storage import Session, engine
from sqlalchemy import event


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--full", action="store_true", help="Compare result identities using a stable SHA256")
    parser.add_argument("--explain", action="store_true")
    parser.add_argument("--queries", nargs="*", default=["", "xau oa", "黄金 oa", "美股 yahoo", "oa", "eurusd", "不存在", "aapl"])
    args = parser.parse_args()
    captured = []

    @event.listens_for(engine, "before_cursor_execute")
    def before(conn, cursor, statement, parameters, context, executemany):
        context.mobile_search_started = time.perf_counter()

    @event.listens_for(engine, "after_cursor_execute")
    def after(conn, cursor, statement, parameters, context, executemany):
        captured.append((time.perf_counter() - context.mobile_search_started, statement, parameters))

    for query in args.queries:
        for mode in ("watch", "create"):
            for iteration in range(args.rounds):
                with Session() as db:
                    captured.clear()
                    start = time.perf_counter()
                    if mode == "watch":
                        result = search(db, query=query, mobile=True, exclude_watch=True, include_total=False,
                            limit=50000 if args.full else 25)
                    else:
                        if args.full:
                            result = search(db, query=query, mobile=True, managed=True, exclude_existing=True,
                                include_total=False, limit=50000)
                        else:
                            result = search_catalog(db, query=query, mobile=True, exclude_existing=True,
                                include_total=False, limit=25)
                    elapsed = time.perf_counter() - start
                    timings = list(captured)
                    ids = sorted(row.get("catalog_id", row.get("id")) for row in result["items"])
                    report = {"query": query, "mode": mode, "iteration": iteration,
                        "elapsed_ms": round(elapsed * 1000, 2), "sql_ms": round(sum(row[0] for row in timings) * 1000, 2),
                        "items": len(ids), "has_more": result.get("has_more"),
                        "identity_sha256": hashlib.sha256(json.dumps(ids).encode()).hexdigest()}
                    if args.explain and iteration == 0:
                        _, sql, params = max(timings, key=lambda row: len(row[1]))
                        plan = db.connection().exec_driver_sql("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql, params).scalar()[0]
                        report["plan"] = plan
                    print(json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
