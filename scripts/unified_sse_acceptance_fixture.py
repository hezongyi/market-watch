"""Write synthetic published bars only in this task's isolated Ubuntu database.

Run through the browser harness, which checks Docker project/image ownership.
This fixture supplies deterministic inputs, not supplier acceptance evidence.
"""

import argparse
import json
from decimal import Decimal

from alerts.chart_data import FRAMES, bounds
from alerts.config import settings
from alerts.domain import Calendar, bucket_bounds
from alerts.storage import (
    AdvancedWorkspace,
    ChartPublication,
    ChartPublishedBar,
    Instrument,
    MarketStreamSubscription,
    MarketStreamTask,
    Preference,
    instant,
    ms,
    now_ms,
    transaction,
)
from sqlalchemy import select, text
from sqlalchemy.engine import make_url

TASK = "mw-unified-sse-20261008"
SYMBOL = "SSEFIXTURE"
WORKSPACE = "unified-sse-synthetic"
MARKER = "acceptance.unified-sse.synthetic"
WIDTH = 60000


def guard():
    url = make_url(settings.database_url)
    if (
        settings.database_application_name != TASK
        or url.get_backend_name() != "postgresql"
        or url.host != "postgres"
        or url.database != "alerts"
        or url.username != "alerts"
        or settings.delivery_enabled
    ):
        raise SystemExit("Refusing any database outside the isolated unified-SSE task")


def payload(start, value, end=None):
    return {
        "start": start, "end": end or start + WIDTH,
        "open": str(value), "high": str(value + 2), "low": str(value - 2),
        "close": str(value + 1), "complete": True, "revision": 1,
        "volume": None, "volume_complete": False,
    }


def seed_period(db, frame):
    if db.get(ChartPublication, (SYMBOL, frame)):
        return
    boundary = bounds if frame in ("M30", "W1", "MN") else bucket_bounds
    right = ms(boundary(instant(now_ms()), frame, Calendar.UTC0)[0])
    end = right
    count = 120 if frame == "MN" else 300 if frame == "W1" else 1400
    for index in range(count):
        left = ms(boundary(instant(right - 1), frame, Calendar.UTC0)[0])
        db.add(ChartPublishedBar(instrument_id=SYMBOL, timeframe=frame,
            start=left, end=right, complete=True, revision=1,
            payload=payload(left, Decimal("100") + Decimal(index % 40) / 10, right)))
        right = left
    db.add(ChartPublication(instrument_id=SYMBOL, timeframe=frame, start=right,
        end=end, complete_count=count, initialized=True, revision=1))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("seed", "tail", "update", "append", "state"))
    parser.add_argument("--close", type=Decimal)
    parser.add_argument("--high", type=Decimal, default=Decimal("110"))
    parser.add_argument("--low", type=Decimal, default=Decimal("90"))
    parser.add_argument("--timeframe", choices=tuple(FRAMES), default="M1")
    args = parser.parse_args()
    guard()
    # Migrations must already have succeeded; deliberately no create_all/bootstrap.
    with transaction() as db:
        marker = db.get(Preference, MARKER)
        if args.action == "seed" and marker is None:
            if db.get(Instrument, SYMBOL) or db.get(AdvancedWorkspace, WORKSPACE):
                raise SystemExit("Fixture identity exists without this task's ownership marker")
            end = now_ms() // WIDTH * WIDTH - 30 * WIDTH
            count = 1400
            db.add(Instrument(id=SYMBOL, symbol=SYMBOL, label="SSE 验收 · 合成行情",
                source="binance", calendar="utc0", basis="last", precision=2,
                enabled=False, calendar_profile={}))
            db.flush()
            for index in range(count):
                start = end - (count - index) * WIDTH
                db.add(ChartPublishedBar(instrument_id=SYMBOL, timeframe="M1",
                    start=start, end=start + WIDTH, complete=True, revision=1,
                    payload=payload(start, Decimal("100") + Decimal(index % 40) / 10)))
            db.add(ChartPublication(instrument_id=SYMBOL, timeframe="M1",
                start=end - count * WIDTH, end=end, complete_count=count,
                initialized=True, revision=1))
            db.add(AdvancedWorkspace(id=WORKSPACE, name="统一 SSE 验收 · 合成行情",
                document={"engine": "tv31", "schemaVersion": 1, "symbol": SYMBOL,
                          "series_kind": "managed", "interval": "1"}))
            marker = Preference(key=MARKER, value={"task": TASK, "synthetic": True})
            db.add(marker)
            db.flush()
        if marker is None or marker.value != {"task": TASK, "synthetic": True}:
            raise SystemExit("Missing or incompatible synthetic fixture ownership")
        if args.action == "seed":
            for frame in FRAMES:
                seed_period(db, frame)
            db.flush()
        pub = db.scalar(select(ChartPublication).where(
            ChartPublication.instrument_id == SYMBOL,
            ChartPublication.timeframe == args.timeframe).with_for_update())
        if pub is None or not pub.initialized:
            raise SystemExit("Missing initialized synthetic publication")
        row = db.scalar(select(ChartPublishedBar).where(
            ChartPublishedBar.instrument_id == SYMBOL,
            ChartPublishedBar.timeframe == args.timeframe).order_by(ChartPublishedBar.start.desc()).limit(1))
        if row is None:
            raise SystemExit("Missing synthetic tail")
        if args.action in ("update", "append"):
            if args.close is None or not all(v.is_finite() for v in (args.close, args.high, args.low)):
                raise SystemExit("A finite close/high/low is required")
            if args.action == "append":
                if args.timeframe != "M1":
                    raise SystemExit("Append fixture supports only M1")
                start = pub.end
                if start + WIDTH > now_ms():
                    raise SystemExit("Refusing future completed synthetic bars")
                row = ChartPublishedBar(instrument_id=SYMBOL, timeframe="M1", start=start,
                    end=start + WIDTH, complete=True, revision=1,
                    payload=payload(start, Decimal("100")))
                db.add(row)
                pub.end = start + WIDTH
                pub.complete_count += 1
            open_value = Decimal(row.payload["open"])
            if not args.low <= min(open_value, args.close) <= max(open_value, args.close) <= args.high:
                raise SystemExit("Invalid synthetic OHLC bounds")
            row.revision += 1
            row.payload = {**row.payload, "close": str(args.close), "high": str(args.high),
                           "low": str(args.low), "revision": row.revision}
            pub.revision += 1
            pub.updated_at = now_ms()
        if args.action == "seed":
            # Ensure the fixture is the first workspace returned by the normal UI.
            workspace = db.get(AdvancedWorkspace, WORKSPACE)
            if workspace is None:
                raise SystemExit("Missing owned fixture workspace")
            workspace.updated_at = now_ms()
        result = {"synthetic": True, "instrument": SYMBOL, "workspace": WORKSPACE,
                  "action": args.action, "timeframe": args.timeframe,
                  "bar": row.payload, "publication_revision": pub.revision}
        if args.action == "state":
            result["tasks"] = [{"id": task.id, "kind": task.identity.get("kind"),
                "indicator_count": len(task.query.get("indicators", [])),
                "timeframe": task.query.get("timeframe"),
                "owner": task.owner_token, "owner_until": task.owner_until,
                "sequence": task.sequence, "expires": task.expires,
                "active_consumers": len(list(db.scalars(select(MarketStreamSubscription.id).where(
                    MarketStreamSubscription.task_id == task.id,
                    MarketStreamSubscription.active.is_(True),
                    MarketStreamSubscription.expires > now_ms()))))}
                for task in db.scalars(select(MarketStreamTask).where(
                    MarketStreamTask.expires > now_ms()))
                if task.query.get("instrument") == SYMBOL]
            if db.get_bind().dialect.name == "postgresql":
                result["database_stats"] = [dict(row._mapping) for row in db.execute(text(
                    "SELECT relname, seq_scan, seq_tup_read, idx_scan, idx_tup_fetch, "
                    "n_tup_ins, n_tup_upd, n_tup_del, n_live_tup "
                    "FROM pg_stat_user_tables WHERE schemaname = 'public' "
                    "AND relname IN ('candles','chart_publications','chart_published_bars', "
                    "'market_stream_tasks','market_stream_results','market_stream_subscriptions') "
                    "ORDER BY relname"))]
    # This timestamp follows the transaction's commit, excluding Docker exec startup.
    result["committed_at"] = now_ms()
    print(json.dumps(result))


if __name__ == "__main__":
    main()
