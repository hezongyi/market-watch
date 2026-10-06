"""Deterministic fixture for the explicitly isolated native MCP acceptance DB."""

import json
from decimal import Decimal

from alerts.config import settings
from alerts.storage import (
    AdvancedWorkspace,
    Bar,
    ChartPublication,
    ChartPublishedBar,
    Instrument,
    Notification,
    Outbox,
    Preference,
    SignalRow,
    bootstrap,
    now_ms,
    transaction,
)
from sqlalchemy import select


def seed_chart_fixture(db):
    # The native managed-chart router requires a supported adapter. This private
    # symbol has no upstream mapping; only its published synthetic snapshot is read.
    db.add(
        Instrument(
            id="MCPFIXTURE",
            symbol="MCPFIXTURE",
            label="SYNTHETIC acceptance-fixture: no live upstream",
            source="binance",
            calendar="utc0",
            basis="last",
            precision=5,
            enabled=False,
            calendar_profile={},
        )
    )
    db.flush()
    for frame in ("H1", "H4"):
        for row in db.scalars(
            select(ChartPublishedBar).where(
                ChartPublishedBar.instrument_id == "EURUSD",
                ChartPublishedBar.timeframe == frame,
            )
        ):
            db.add(
                ChartPublishedBar(
                    instrument_id="MCPFIXTURE",
                    timeframe=frame,
                    start=row.start,
                    end=row.end,
                    complete=row.complete,
                    revision=row.revision,
                    payload=row.payload,
                )
            )
        row = db.get(ChartPublication, ("EURUSD", frame))
        db.add(
            ChartPublication(
                instrument_id="MCPFIXTURE",
                timeframe=frame,
                start=row.start,
                end=row.end,
                complete_count=row.complete_count,
                initialized=True,
            )
        )
    for row in db.scalars(select(Bar).where(Bar.instrument_id == "EURUSD", Bar.timeframe == "M1")):
        db.add(
            Bar(
                instrument_id="MCPFIXTURE",
                timeframe="M1",
                start=row.start,
                end=row.end,
                open=row.open,
                high=row.high,
                low=row.low,
                close=row.close,
                complete=True,
            )
        )


if settings.database_application_name not in ("mw-native-mcp-acceptance", "mw-chart-alerts-integration"):
    raise SystemExit("Refusing to seed a database outside the named isolated acceptance projects")
bootstrap()
with transaction() as db:
    if db.get(Preference, "acceptance.native-mcp.fixture"):
        raise SystemExit("Fixture already exists; preserving current acceptance data")
    inst = db.get(Instrument, "EURUSD")
    inst.source = "acceptance-fixture"
    inst.label = "EURUSD · deterministic isolated acceptance fixture"
    end = now_ms() // 3600000 * 3600000
    for frame, width, count in [("H1", 3600000, 240), ("H4", 14400000, 100), ("M1", 60000, 1)]:
        for index in range(count):
            start = end - (count - index) * width
            value = Decimal("1.10000") + Decimal(index % 40) / 100000
            candle = Bar(
                instrument_id="EURUSD",
                timeframe=frame,
                start=start,
                end=start + width,
                open=value,
                high=value + Decimal(".00030"),
                low=value - Decimal(".00020"),
                close=value + Decimal(".00010"),
                complete=True,
            )
            db.add(candle)
            if frame != "M1":
                db.add(
                    ChartPublishedBar(
                        instrument_id=inst.id,
                        timeframe=frame,
                        start=start,
                        end=start + width,
                        complete=True,
                        revision=1,
                        payload={
                            "start": start,
                            "end": start + width,
                            "open": str(value),
                            "high": str(value + Decimal(".00030")),
                            "low": str(value - Decimal(".00020")),
                            "close": str(value + Decimal(".00010")),
                            "complete": True,
                            "revision": 1,
                            "volume": None,
                            "volume_complete": False,
                        },
                    )
                )
        if frame != "M1":
            db.add(
                ChartPublication(
                    instrument_id=inst.id,
                    timeframe=frame,
                    start=end - count * width,
                    end=end,
                    complete_count=count,
                    initialized=True,
                )
            )
    from alerts.business import WatchInput
    from alerts.service import create_watch

    watch = create_watch(
        db,
        "EURUSD",
        "MCP notification fixture",
        WatchInput(
            instrument_id="EURUSD", name="MCP notification fixture", kind="price", level="1.2"
        ).rule(),
        use_history=False,
    )
    signal = SignalRow(
        watch_id=watch.id,
        instrument_id="EURUSD",
        occurred_at=now_ms(),
        direction="buy",
        price=Decimal("1.2"),
        threshold=Decimal("1.2"),
        reason="acceptance fixture",
        evidence={"synthetic": True},
    )
    db.add(signal)
    db.flush()
    note = Notification(id="native-mcp-note-fixture", signal_id=signal.id)
    db.add(note)
    db.flush()
    db.add(Outbox(notification_id=note.id))
    document = {
        "engine": "tv31",
        "schemaVersion": 1,
        "state": {
            "_mwDrawingProjection": {
                "version": 1,
                "charts": [
                    {
                        "chart_id": "0",
                        "symbol": "EURUSD",
                        "resolution": "60",
                        "drawings": [
                            {
                                "id": "fixture-level",
                                "name": "horizontal_line",
                                "points": [{"price": 1.1, "time": end // 1000}],
                            },
                            {"id": "fixture-unknown", "name": "unsupported_test", "points": []},
                        ],
                    }
                ],
            }
        },
    }
    db.add(
        AdvancedWorkspace(
            id="native-mcp-fixture", name="Deterministic MCP acceptance fixture", document=document
        )
    )
    db.add(
        Preference(
            key="acceptance.native-mcp.fixture", value={"seeded_at": now_ms(), "synthetic": True}
        )
    )
    db.flush()
    seed_chart_fixture(db)
print(
    json.dumps({"fixture": "native-mcp-fixture", "source": "acceptance-fixture", "synthetic": True})
)
