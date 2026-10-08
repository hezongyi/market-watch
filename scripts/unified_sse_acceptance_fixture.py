"""Write synthetic published bars only in this task's isolated Ubuntu database.

Run through the browser harness, which checks Docker project/image ownership.
This fixture supplies deterministic inputs, not supplier acceptance evidence.
"""

import argparse
import json
from decimal import Decimal

from alerts.config import settings
from alerts.storage import (
    AdvancedWorkspace,
    ChartPublication,
    ChartPublishedBar,
    Instrument,
    MarketStreamTask,
    Preference,
    now_ms,
    transaction,
)
from sqlalchemy import select
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


def payload(start, value):
    return {
        "start": start, "end": start + WIDTH,
        "open": str(value), "high": str(value + 2), "low": str(value - 2),
        "close": str(value + 1), "complete": True, "revision": 1,
        "volume": None, "volume_complete": False,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("seed", "tail", "update", "append", "state"))
    parser.add_argument("--close", type=Decimal)
    parser.add_argument("--high", type=Decimal, default=Decimal("110"))
    parser.add_argument("--low", type=Decimal, default=Decimal("90"))
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
        pub = db.scalar(select(ChartPublication).where(
            ChartPublication.instrument_id == SYMBOL,
            ChartPublication.timeframe == "M1").with_for_update())
        if pub is None or not pub.initialized:
            raise SystemExit("Missing initialized synthetic publication")
        row = db.get(ChartPublishedBar, (SYMBOL, "M1", pub.end - WIDTH))
        if row is None:
            raise SystemExit("Missing synthetic tail")
        if args.action in ("update", "append"):
            if args.close is None or not all(v.is_finite() for v in (args.close, args.high, args.low)):
                raise SystemExit("A finite close/high/low is required")
            if args.action == "append":
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
                  "action": args.action, "bar": row.payload, "publication_revision": pub.revision}
        if args.action == "state":
            result["tasks"] = [{"id": task.id, "kind": task.identity.get("kind"),
                "indicator_count": len(task.query.get("indicators", [])),
                "owner": task.owner_token, "owner_until": task.owner_until,
                "sequence": task.sequence, "expires": task.expires}
                for task in db.scalars(select(MarketStreamTask).where(
                    MarketStreamTask.expires > now_ms()))
                if task.query.get("instrument") == SYMBOL]
    # This timestamp follows the transaction's commit, excluding Docker exec startup.
    result["committed_at"] = now_ms()
    print(json.dumps(result))


if __name__ == "__main__":
    main()
