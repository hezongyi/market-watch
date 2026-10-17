"""D0 for Issue #82: real auth/API/PG, deterministic supplier boundary, no network."""

# ruff: noqa: E402 -- acquisition boundaries must be installed before API import.
from decimal import Decimal

from alerts import provider_chart, provider_service, provider_transport, storage
from alerts.config import settings
from sqlalchemy.engine import make_url

url = make_url(settings.database_url)
if (
    url.host != "postgres"
    or url.database != "single_app"
    or settings.database_application_name != "mw-issue82-20261017"
    or settings.delivery_enabled
    or settings.oanda_token
    or settings.yahoo_enabled
):
    raise RuntimeError(
        "Fixture requires the isolated Issue #82 PostgreSQL and disabled delivery/suppliers"
    )
provider_chart.warm_clients = lambda: None
provider_service.start = lambda: None
provider_service.stop = lambda: None
provider_transport.start = lambda _: None
storage.bootstrap()

BASE = {
    "EURUSD": Decimal("1.10"),
    "XAUUSD": Decimal("2600"),
    "BTCUSDT": Decimal("62000"),
    "ALT_EURUSD": Decimal("1.30"),
}
clock = storage.now_ms() // 60000 * 60000
original_metadata = provider_chart.metadata


def metadata(ident, **kwargs):
    if ident not in BASE:
        return original_metadata(ident, **kwargs)
    return dict(
        id=ident,
        symbol="BTCUSDT" if ident == "BTCUSDT" else "EUR_USD" if "EURUSD" in ident else "XAU_USD",
        source="binance" if ident in ("BTCUSDT", "ALT_EURUSD") else "oanda",
        basis="bid",
        calendar="utc0" if ident == "BTCUSDT" else "ny17",
        precision=5 if "EURUSD" in ident else 2,
        name="合成 " + ident,
        display_symbol="EURUSD" if "EURUSD" in ident else ident,
        asset_type="CURRENCY",
    )


provider_chart.metadata = metadata

WIDTHS = {
    "M1": 60000,
    "M5": 300000,
    "M15": 900000,
    "M30": 1800000,
    "H1": 3600000,
    "H4": 14400000,
    "D1": 86400000,
    "W1": 604800000,
    "MN": 2592000000,
}


def native_page(meta, frame, before, count, **kwargs):
    clock = storage.now_ms() // 60000 * 60000
    width = WIDTHS[frame]
    right = min(clock // width * width + width, (before - 1) // width * width + width)
    rows = []
    for at in range(right - min(count, 1200) * width, right, width):
        price = BASE.get(meta["id"], Decimal("1.1")) + Decimal(at // width % 17) / Decimal("100000")
        rows.append(
            dict(
                start=at,
                end=at + width,
                chart_time=at,
                open=str(price),
                high=str(price + Decimal(".0002")),
                low=str(price - Decimal(".0002")),
                close=str(price + Decimal(".0001")),
                complete=at + width <= clock,
                volume="10",
                volume_complete=True,
            )
        )
    return dict(
        bars=rows,
        history_boundary=False,
        as_of=clock,
        cache_hit=False,
        series_kind="provider",
        basis=meta["basis"],
        calendar=meta["calendar"],
        precision=meta["precision"],
    )


provider_chart.native_page = native_page

from alerts import api  # noqa: E402
from alerts import provider_cache as cache  # noqa: E402
from alerts.advanced_api import preference_id  # noqa: E402
from alerts.storage import (  # noqa: E402
    AdvancedPreference,
    AdvancedWorkspace,
    ChartWorkspace,
    HistoryVersion,
    Notification,
    Outbox,
    Preference,
    SignalRow,
    Watch,
    transaction,
)

# Persisted caches are exercised by the real foreground data/quote paths.
for ident in BASE:
    meta = metadata(ident)
    for frame in ("M1", "H1", "D1"):
        key = cache.ensure(meta, frame)
        lease = cache.claim(key)
        if lease:
            try:
                cache.commit_page(
                    key,
                    lease,
                    native_page(meta, frame, clock + 1, 1000),
                    clock + 1,
                    clock,
                    latest=True,
                )
            finally:
                cache.release(key, lease)

with transaction() as db:
    marker = db.get(Preference, "acceptance.issue82")
if not marker:
    from alerts import history_versions as history
    from alerts.history_artifacts import artifact_tick, request_artifacts
    from alerts.market_contracts import CandleBatch, DatasetIdentity, MinuteRow, RequestResult
    from alerts.market_datasets import register_dataset

    identity = DatasetIdentity(
        source="dukascopy",
        channel="python",
        environment="historical",
        account_scope="public",
        provider_symbol="EUR/USD",
        basis="bid",
        calendar_version="issue82-d0-ny17-v1",
    )
    start, end = 1791158400000, 1791331200000
    with transaction() as db:
        inst = register_dataset(
            db,
            identity,
            logical_symbol="EURUSD",
            label="Issue82 合成固定历史",
            calendar="ny17",
            precision=5,
            volume_kind="quantity",
            volume_unit="source_quantity",
        )
        history_instrument = inst.id
        version = history.create_version(db, identity.key, start, end)

    class Adapter:
        def page(self, identity, start, end):
            rows = tuple(
                MinuteRow(
                    timestamp=at,
                    open="1.10",
                    high="1.12",
                    low="1.09",
                    close="1.11",
                    volume="10",
                    complete=True,
                )
                for at in range(start, end, 60000)
            )
            return CandleBatch(
                identity=identity,
                window_start=start,
                window_end=end,
                observed_at=end + 60000,
                result=RequestResult(status="data"),
                rows=rows,
                checkpoint=end,
                volume_kind="quantity",
                volume_unit="source_quantity",
            )

    for _ in range(30):
        history.import_page(Adapter(), version_id=version)
        with transaction() as db:
            current = db.get(HistoryVersion, version)
            if current.error:
                raise RuntimeError(current.error)
            if current.status == "published":
                request_artifacts(db, current, ["M1", "H1", "D1"])
                break
    else:
        raise RuntimeError("D0 history did not publish")
    while artifact_tick(version):
        pass
    with transaction() as db:
        for ident, symbol in [
            ("issue82-a", "MWP:EURUSD"),
            ("issue82-b", "MWP:XAUUSD"),
            ("issue82-history", "MWH:" + version),
        ]:
            db.add(
                AdvancedWorkspace(
                    id=ident,
                    name=ident + " 合成验收",
                    document=dict(engine="tv31", schemaVersion=1, symbol=symbol, interval="60"),
                )
            )
        db.add(
            ChartWorkspace(
                id="issue82-legacy",
                name="历史工作区保留样例",
                document={
                    "schemaVersion": 1,
                    "layout": "1",
                    "sync": True,
                    "drawings": {},
                    "panels": [
                        {
                            "id": "issue82-panel",
                            "instrument": "BTCUSDT",
                            "timeframe": "H1",
                            "indicators": [],
                            "timezone": "native",
                            "follow": True,
                        }
                    ],
                },
            )
        )
        db.add(
            AdvancedPreference(
                id=preference_id("setting", "mw.watchlists.v1", ""),
                kind="setting",
                name="mw.watchlists.v1",
                tool="",
                content={
                    "value": {
                        "active": "issue82-list-a",
                        "lists": [
                            {
                                "id": "issue82-list-a",
                                "title": "验收列表 A",
                                "symbols": [
                                    "MWP:EURUSD",
                                    "MWP:XAUUSD",
                                    "MWP:BTCUSDT",
                                    "MWP:ALT_EURUSD",
                                ],
                            },
                            {
                                "id": "issue82-list-b",
                                "title": "验收列表 B",
                                "symbols": ["MWP:XAUUSD", "MWP:EURUSD"],
                            },
                        ],
                    }
                },
            )
        )
        db.add(
            Watch(
                id="issue82-watch",
                instrument_id="EURUSD",
                name="旧 Watch 取消验收",
                rule={"kind": "price", "direction": "buy", "threshold": "1.20", "timeframe": "H1"},
                state={},
                status="active",
                armed_at=0,
            )
        )
        db.flush()
        for ident, watch, reason in [
            ("issue82-legacy-signal", "issue82-watch", "旧 Watch 触发样例")
        ]:
            db.add(
                SignalRow(
                    id=ident,
                    watch_id=watch,
                    instrument_id="EURUSD",
                    occurred_at=clock,
                    created_at=clock,
                    direction="buy",
                    price=Decimal("1.11"),
                    threshold=Decimal("1.10"),
                    reason=reason,
                    evidence={"fixture": "D0"},
                )
            )
            db.flush()
            db.add(Notification(id=ident + "-note", signal_id=ident, status="blocked"))
            db.flush()
            db.add(
                Outbox(
                    notification_id=ident + "-note",
                    status="blocked",
                    error="D0 controlled credential failure",
                    next_at=0,
                )
            )
        from alerts.chart_alert_domain import Observation
        from alerts.chart_alert_service import AlertConfig, consume, create

        config = AlertConfig.model_validate(
            {
                "name": "图表告警触发样例",
                "instrument": "EURUSD",
                "source": "oanda",
                "series_kind": "provider",
                "timeframe": "M1",
                "notify_ntfy": True,
                "condition": {
                    "relation": "cross_up",
                    "left": {"kind": "price"},
                    "right": {"kind": "constant", "value": "1.10"},
                },
            }
        )
        alert = create(
            db,
            "issue82-chart-alert",
            config,
            dataset_id=cache.ensure(metadata("EURUSD"), "M1"),
            at=clock - 120000,
        )
        consume(
            db,
            alert.id,
            Observation(
                "issue82-before",
                0,
                clock - 60000,
                Decimal("1.09"),
                Decimal("1.10"),
                Decimal("1.09"),
            ),
            detected_at=clock - 60000,
        )
        chart_signal = consume(
            db,
            alert.id,
            Observation(
                "issue82-after", 1, clock, Decimal("1.11"), Decimal("1.10"), Decimal("1.11")
            ),
            detected_at=clock,
        )
        if chart_signal is None:
            raise RuntimeError("D0 real chart alert did not trigger")
        db.add(
            Preference(
                key="acceptance.issue82",
                value={
                    "synthetic": True,
                    "version": version,
                    "history_instrument": history_instrument,
                    "start": start,
                    "end": end,
                    "chart_signal": chart_signal.id,
                },
            )
        )

app = api.app

# Run the actual bounded calculation/history turns against the synthetic supplier.
# These loops own only this task's DB; delivery and external acquisition stay off.
import logging
import threading

from alerts.market_stream_worker import Calculator, tick
from alerts.native_history_loads import once

stopped = threading.Event()
threads = []


def start_workers():
    def run(work):
        while not stopped.is_set():
            try:
                worked = work()
            except Exception:
                logging.exception("Issue82 fixture worker failed")
                worked = False
            stopped.wait(0.05 if worked else 0.25)

    calculator = Calculator()
    for work in (once, lambda: tick(calculator)):
        thread = threading.Thread(target=run, args=(work,), daemon=True)
        thread.start()
        threads.append(thread)


def stop_workers():
    stopped.set()
    for thread in threads:
        thread.join(timeout=5)


provider_service.start = start_workers
provider_service.stop = stop_workers


if __name__ == "__main__":
    import argparse

    from sqlalchemy import select

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reset-interactions", action="store_true", required=True)
    parser.parse_args()
    # Explicit, repeatable D0 reset. Never delete events, workspaces or volumes.
    # The module-level database/application guards also protect this entry point.
    with transaction() as db:
        fixture = db.get(Preference, "acceptance.issue82")
        if not fixture or not fixture.value.get("synthetic"):
            raise RuntimeError("Issue82 synthetic marker required")
        watch = db.get(Watch, "issue82-watch")
        note = db.get(Notification, "issue82-legacy-signal-note")
        task = db.scalar(select(Outbox).where(Outbox.notification_id == note.id))
        watch.status = "active"
        note.ack_at = None
        note.status = task.status = "blocked"
        task.next_at = task.attempts = 0
        task.lease_until = None
        task.error = "D0 controlled credential failure"
    print("Reset Issue82 synthetic Watch/notification interactions only")
