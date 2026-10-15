"""Small fixed-time synthetic data. Only runs inside a task-owned preview network."""

import os
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
    transaction,
)
from sqlalchemy import func, select
from sqlalchemy.engine import make_url

START = 1791158400000  # 2026-10-05 00:00 UTC; fixed, not a live supplier health fixture.
COUNT = 720


def validate():
    url = make_url(settings.database_url)
    task = os.environ.get("MW_PREVIEW_TASK", "")
    dataset = os.environ.get("MW_PREVIEW_DATASET", "")
    if (
        not task.startswith(("mw-", "market-watch-"))
        or "production" in task
        or settings.database_application_name != task
        or not dataset.startswith("d1-v1-")
        or url.host != "postgres"
        or url.username != "preview"
        or not (url.database == "preview" or (url.database or "").startswith("preview_"))
        or settings.delivery_enabled
        or settings.yahoo_enabled
        or settings.oanda_stream_enabled
        or settings.database_expected_version != 140024
    ):
        raise ValueError("Refusing to seed outside an isolated preview configuration")
    return dataset


def seed(dataset):
    with transaction() as db:
        key = "acceptance.preview.dataset"
        existing = db.get(Preference, key)
        if existing:
            if existing.value["dataset"] != dataset:
                raise ValueError("Different dataset preserved; use explicit preview reset")
            return "reused"
        if db.scalar(select(func.count()).select_from(Bar)):
            raise ValueError("Unrecognized candle data preserved; refuse to seed")
        for item in db.scalars(select(Instrument)):
            item.enabled = False
        for code, source, price, calendar in [
            ("D1_EURUSD", "dukascopy", "1.10", "ny17"),
            ("D1_XAUUSD", "dukascopy", "2600", "ny17"),
            ("D1_BTCUSDT", "binance", "62000", "utc0"),
            ("D1_AAPL", "yahoo", "220", "yahoo"),
        ]:
            db.add(
                Instrument(
                    id=code,
                    symbol=code,
                    label="D1 synthetic " + code,
                    source=source,
                    basis="last" if source in ("binance", "yahoo") else "bid",
                    calendar=calendar,
                    precision=5 if code == "D1_EURUSD" else 2,
                    enabled=False,
                )
            )
            db.flush()
            for timeframe, width in [("M1", 60000), ("H1", 3600000)]:
                for i in range(COUNT):
                    value = Decimal(price) + Decimal(i % 17) / 100
                    at = START + i * width
                    payload = {
                        "start": at,
                        "end": at + width,
                        "open": str(value),
                        "high": str(value + 1),
                        "low": str(value - 1),
                        "close": str(value),
                        "complete": True,
                        "revision": 1,
                        "volume": None,
                        "volume_complete": False,
                    }
                    db.add(
                        Bar(
                            instrument_id=code,
                            timeframe=timeframe,
                            start=at,
                            end=at + width,
                            open=value,
                            high=value + 1,
                            low=value - 1,
                            close=value,
                            complete=True,
                            received_at=START,
                            observed_at=START,
                        )
                    )
                    db.add(
                        ChartPublishedBar(
                            instrument_id=code,
                            timeframe=timeframe,
                            start=at,
                            end=at + width,
                            payload=payload,
                            complete=True,
                            revision=1,
                        )
                    )
                db.add(
                    ChartPublication(
                        instrument_id=code,
                        timeframe=timeframe,
                        start=START,
                        end=START + COUNT * width,
                        complete_count=COUNT,
                        initialized=True,
                        updated_at=START,
                    )
                )
            db.add(
                AdvancedWorkspace(
                    id=code,
                    name="D1 " + code,
                    document={
                        "engine": "tv31",
                        "schemaVersion": 1,
                        "symbol": code,
                        "series_kind": "managed",
                        "interval": "60",
                    },
                    updated_at=START,
                )
            )
        db.add(
            Preference(
                key=key,
                value={
                    "dataset": dataset,
                    "synthetic": True,
                    "start": START,
                    "candles": 4 * 2 * COUNT,
                },
            )
        )
    return "seeded"


if __name__ == "__main__":
    dataset = validate()
    bootstrap()
    print({"dataset": dataset, "state": seed(dataset), "real_supplier_connections": False})
