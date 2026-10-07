"""Synthetic candles for the explicitly named isolated chart-maximize database."""

from decimal import Decimal

from alerts.config import settings
from alerts.storage import (
    AdvancedWorkspace,
    Bar,
    ChartPublication,
    ChartPublishedBar,
    Instrument,
    Preference,
    bootstrap,
    now_ms,
    transaction,
)
from sqlalchemy.engine import make_url

url = make_url(settings.database_url)
if (
    settings.database_application_name != "mw-chart-maximize-20261007"
    or url.host != "pg"
    or url.database != "chart_maximize"
    or url.username != "chart_maximize"
    or settings.delivery_enabled
):
    raise SystemExit("Refusing to seed anything outside the isolated chart-maximize project")

bootstrap()
with transaction() as db:
    if db.get(Preference, "acceptance.chart-maximize.fixture"):
        print("Existing fixture preserved")
    else:
        inst = Instrument(
            id="MAXFIXTURE", symbol="MAXFIXTURE", label="双击验收 · 合成行情",
            source="binance", calendar="utc0", basis="last", precision=2, enabled=False,
            calendar_profile={},
        )
        db.add(inst)
        db.flush()
        width, count = 3600000, 1200
        end = now_ms() // width * width
        for index in range(count):
            start = end - (count - index) * width
            value = Decimal("100") + Decimal(index % 40) / 10
            payload = {
                "start": start, "end": start + width,
                "open": str(value), "high": str(value + 2), "low": str(value - 2),
                "close": str(value + 1), "complete": True, "revision": 1,
                "volume": None, "volume_complete": False,
            }
            db.add(Bar(
                instrument_id=inst.id, timeframe="H1", start=start, end=start + width,
                open=value, high=value + 2, low=value - 2, close=value + 1, complete=True,
            ))
            db.add(ChartPublishedBar(
                instrument_id=inst.id, timeframe="H1", start=start, end=start + width,
                complete=True, revision=1, payload=payload,
            ))
        db.add(ChartPublication(
            instrument_id=inst.id, timeframe="H1", start=end - count * width, end=end,
            complete_count=count, initialized=True,
        ))
        db.add(AdvancedWorkspace(
            id="chart-maximize-fixture", name="双击放大验收 · 合成行情",
            document={"engine": "tv31", "schemaVersion": 1, "symbol": inst.id,
                      "series_kind": "managed", "interval": "60"},
        ))
        db.add(Preference(key="acceptance.chart-maximize.fixture", value={"synthetic": True}))
        print("Seeded isolated synthetic H1 candles and chart workspace")
