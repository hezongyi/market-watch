"""Deterministic fixture for the explicitly isolated native MCP acceptance DB."""

import json
from decimal import Decimal

from alerts.config import settings
from alerts.storage import (
    AdvancedWorkspace,
    Bar,
    Instrument,
    Notification,
    Outbox,
    Preference,
    SignalRow,
    bootstrap,
    now_ms,
    transaction,
)

if settings.database_application_name != "mw-native-mcp-acceptance":
    raise SystemExit("Refusing to seed a database outside mw-native-mcp-acceptance")
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
            db.add(
                Bar(
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
print(
    json.dumps({"fixture": "native-mcp-fixture", "source": "acceptance-fixture", "synthetic": True})
)
