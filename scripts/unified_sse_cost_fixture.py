"""Identical synthetic inputs using only models present in old release 6fd9273.

The harness verifies local Docker image/project ownership before piping this
source into each API. No supplier acceptance or production data is involved.
"""

import argparse
import json
from decimal import Decimal

from alerts.chart_data import bounds
from alerts.config import settings
from alerts.domain import Calendar, bucket_bounds
from alerts.storage import (
    AdvancedWorkspace,
    Bar,
    ChartPublication,
    ChartPublishedBar,
    Instrument,
    Preference,
    instant,
    ms,
    now_ms,
    transaction,
)
from sqlalchemy import select
from sqlalchemy.engine import make_url

PROJECTS = ("mw-unified-sse-baseline-20261009", "mw-unified-sse-lease-optimization")
FRAMES = ("M1", "M5", "M15", "M30", "H1", "H4", "W1", "MN")
SYMBOL = "SSECOST"
WORKSPACE = "unified-sse-cost"
MARKER = "acceptance.unified-sse.cost"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("seed", "update"))
    parser.add_argument("--project", required=True, choices=PROJECTS)
    parser.add_argument("--seed-at", required=True, type=int)
    parser.add_argument("--frames", default="M1")
    parser.add_argument("--close", type=Decimal)
    args = parser.parse_args()
    url = make_url(settings.database_url)
    if (settings.database_application_name != args.project or settings.delivery_enabled
            or (url.get_backend_name(), url.host, url.database, url.username)
            != ("postgresql", "postgres", "alerts", "alerts")):
        raise SystemExit("Only the explicitly owned isolated cost database is allowed")
    frames = args.frames.split(",")
    if not frames or len(set(frames)) != len(frames) or any(f not in FRAMES for f in frames):
        raise SystemExit("Invalid cost timeframe set")
    if not 0 < args.seed_at <= now_ms():
        raise SystemExit("A historical fixture clock is required")
    expected = {"task": args.project, "synthetic": True, "seed_at": args.seed_at}
    with transaction() as db:
        marker = db.get(Preference, MARKER)
        if args.action == "seed" and not marker:
            if db.get(Instrument, SYMBOL) or db.get(AdvancedWorkspace, WORKSPACE):
                raise SystemExit("Fixture identity has no ownership marker")
            db.add(Instrument(id=SYMBOL, symbol=SYMBOL, label="成本对照 · 合成行情",
                source="binance", calendar="utc0", basis="last", precision=2,
                enabled=False, calendar_profile={}))
            db.add(AdvancedWorkspace(id=WORKSPACE, name="统一订阅成本对照",
                document={"engine": "tv31", "schemaVersion": 1, "symbol": SYMBOL,
                          "series_kind": "managed", "interval": "1"}))
            marker = Preference(key=MARKER, value=expected)
            db.add(marker)
            db.flush()
        if not marker or marker.value != expected:
            raise SystemExit("Missing or incompatible cost fixture ownership/clock")
        if args.action == "seed":
            for frame in FRAMES:
                if db.get(ChartPublication, (SYMBOL, frame)):
                    continue
                boundary = bounds if frame in ("M30", "W1", "MN") else bucket_bounds
                right = ms(boundary(instant(args.seed_at), frame, Calendar.UTC0)[0])
                end = right
                count = 120 if frame == "MN" else 300 if frame == "W1" else 1400
                for index in range(count):
                    left = ms(boundary(instant(right - 1), frame, Calendar.UTC0)[0])
                    price = Decimal("100") + Decimal(index % 40) / 10
                    db.add(ChartPublishedBar(instrument_id=SYMBOL, timeframe=frame,
                        start=left, end=right, complete=True, revision=1, payload={
                            "start": left, "end": right, "open": str(price),
                            "high": "110", "low": "90", "close": str(price + 1),
                            "complete": True, "revision": 1,
                            "volume": None, "volume_complete": False}))
                    right = left
                db.add(ChartPublication(instrument_id=SYMBOL, timeframe=frame,
                    start=right, end=end, complete_count=count, initialized=True, revision=1))
            db.get(AdvancedWorkspace, WORKSPACE).updated_at = now_ms()
            db.flush()
        output = []
        for frame in (FRAMES if args.action == "seed" else frames):
            pub = db.get(ChartPublication, (SYMBOL, frame))
            row = db.scalar(select(ChartPublishedBar).where(
                ChartPublishedBar.instrument_id == SYMBOL,
                ChartPublishedBar.timeframe == frame).order_by(ChartPublishedBar.start.desc()).limit(1))
            if not pub or not row:
                raise SystemExit("Missing cost publication")
            if args.action == "seed":
                # Repeated benchmark runs must start from the same tail price,
                # rather than retaining the previous arm's final update.
                row.revision += 1
                row.payload = {**row.payload, "close": "107.00", "revision": row.revision}
                pub.revision += 1
                pub.updated_at = now_ms()
            else:
                if args.close is None or not args.close.is_finite() or not 90 <= args.close <= 110:
                    raise SystemExit("A finite close within OHLC bounds is required")
                row.revision += 1
                row.payload = {**row.payload, "close": str(args.close), "revision": row.revision}
                pub.revision += 1
                pub.updated_at = now_ms()
            if frame == "M1":
                bar = db.scalar(select(Bar).where(Bar.instrument_id == SYMBOL,
                    Bar.timeframe == "M1", Bar.start == row.start))
                if not bar:
                    bar = Bar(instrument_id=SYMBOL, timeframe="M1", start=row.start, end=row.end)
                    db.add(bar)
                for field in ("open", "high", "low", "close"):
                    setattr(bar, field, Decimal(row.payload[field]))
                bar.complete, bar.revision, bar.received_at = True, row.revision, now_ms()
                bar.volume, bar.volume_complete = None, False
            output.append({"period": frame, "bar": row.payload, "publication_revision": pub.revision})
    print(json.dumps({"inputs": output, "committed_at": now_ms(), "synthetic": True}))


if __name__ == "__main__":
    main()
