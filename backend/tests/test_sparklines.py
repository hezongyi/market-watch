"""Real cache readers: identities, finite budgets, no supplier or task side effects."""

from datetime import datetime
from decimal import Decimal

import httpx
import pytest
from alerts import api, provider_cache, provider_chart, sparklines, storage
from alerts.sparkline_api import SparklineItem
from alerts.storage import (
    Bar,
    CompositeRevision,
    HistoryChunk,
    Instrument,
    LoginSession,
    MarketCatalog,
    MarketDataset,
    ProviderBar,
    ProviderDataset,
)
from fastapi.testclient import TestClient
from sqlalchemy import event, func, select, update
from test_composite_preparation import ready


def stamp(value):
    return int(datetime.fromisoformat(value).timestamp() * 1000)


def read(*tickers):
    return sparklines.batch([SparklineItem(ticker=ticker) for ticker in tickers])["items"]


@pytest.mark.parametrize("at,hours", [
    ("2026-03-08T12:00:00+00:00", 23),
    ("2026-11-01T12:00:00+00:00", 25),
    ("2026-11-02T12:00:00+00:00", 24),
])
def test_ny17_uses_adjacent_local_dates(at, hours):
    left, right = sparklines.window(stamp(at), "forex")
    assert left <= stamp(at) < right and right - left == hours * 3600000
    assert sparklines.window(stamp(at), "metal") == (left, right)
    utc_left, utc_right = sparklines.window(stamp(at), "unknown")
    assert utc_right - utc_left == 86400000 and utc_left % 86400000 == 0


def catalog(db, ticker="TEST", *, asset="CRYPTO"):
    db.add(MarketCatalog(id=ticker, source="binance", symbol="BTCUSDT", label="Test",
                         asset_type=asset, precision=8, calendar="utc0"))
    db.add(Instrument(id=ticker, source="binance", symbol="BTCUSDT", label="Test",
                      precision=8, calendar="utc0"))


def provider_rows(db, meta, frame, starts, *, price="123.45678901"):
    key = provider_cache.identity(meta, frame)
    db.add(ProviderDataset(id=key, source=meta["source"], symbol=meta["symbol"],
        timeframe=frame, metadata_json=meta, coverage=[], revision=4, accessed_at=1))
    for at in starts:
        db.add(ProviderBar(dataset_id=key, start=at, chart_time=at + 999999999,
            complete=True, payload={"start": at, "end": at + sparklines.FRAMES.get(frame, 86400000),
                "close": price, "complete": True}, observed_at=at + 100))
    return key


def test_provider_prefers_current_m1_retains_gaps_precision_and_source_times(database, monkeypatch):
    now = stamp("2026-11-11T00:10:30+00:00")
    left, _ = sparklines.window(now, None)
    monkeypatch.setattr(storage, "now_ms", lambda: now)
    with database.begin() as db:
        catalog(db)
    meta = provider_chart.metadata("TEST", cached_only=True)
    with database.begin() as db:
        key = provider_rows(db, meta, "M1", [left - 60000, left, left + 60000, left + 180000])
        provider_rows(db, meta, "M5", [left], price="999")
        # An old account/calendar identity must never be selected by source/symbol.
        other = {**meta, "basis": "different"}
        provider_rows(db, other, "M1", [left + 240000], price="888")
    item = read("MWP:TEST")[0]
    assert item["timeframe"] == "M1" and item["status"] == "partial"
    assert [p["time"] for p in item["points"]] == [left, left + 60000, left + 180000]
    assert [p["gap_before"] for p in item["points"]] == [False, False, True]
    assert {p["price"] for p in item["points"]} == {"123.45678901"}
    assert item["revision"] == {"cache_revision": 4}
    with database() as db:
        assert db.get(ProviderDataset, key).accessed_at == 1


def test_period_fallback_never_reuses_yesterday_or_daily_labels(database, monkeypatch):
    now = stamp("2026-11-11T00:10:00+00:00")
    left, _ = sparklines.window(now, None)
    monkeypatch.setattr(storage, "now_ms", lambda: now)
    with database.begin() as db:
        catalog(db)
    meta = provider_chart.metadata("TEST", cached_only=True)
    with database.begin() as db:
        provider_rows(db, meta, "M1", [left - 60000])
        provider_rows(db, meta, "M5", [left])
        provider_rows(db, meta, "D1", [left])
    assert read("MWP:TEST")[0]["timeframe"] == "M5"
    monkeypatch.setattr(storage, "now_ms", lambda: now + 86400000)
    item = read("MWP:TEST")[0]
    assert item["status"] == "empty" and item["points"] == [] and item["timeframe"] is None


def test_type_comes_from_metadata_and_never_ticker_text(database, monkeypatch):
    now = stamp("2026-11-11T12:00:00+00:00")
    monkeypatch.setattr(storage, "now_ms", lambda: now)
    with database.begin() as db:
        catalog(db, "NOT_A_CURRENCY_CODE", asset="CURRENCY")
        catalog(db, "XAUUSD_UNKNOWN", asset="unknown")
    fx, unknown = read("MWP:NOT_A_CURRENCY_CODE", "MWP:XAUUSD_UNKNOWN")
    assert fx["window_start"] == stamp("2026-11-10T22:00:00+00:00")
    assert unknown["window_start"] == stamp("2026-11-11T00:00:00+00:00")


def test_managed_keeps_cache_islands_and_excludes_invalid_partial(database, monkeypatch):
    now = stamp("2026-11-11T00:10:30+00:00")
    left, _ = sparklines.window(now, None)
    monkeypatch.setattr(storage, "now_ms", lambda: now)
    with database.begin() as db:
        catalog(db)
        for offset in (0, 60000, 180000, 240000):
            db.add(Bar(instrument_id="TEST", timeframe="M1", start=left + offset,
                end=left + offset + 60000, open=Decimal("2.1"), high=Decimal("2.1"),
                low=Decimal("2.1"), close=Decimal("2.1"), complete=offset != 180000))
    managed, provider = read("TEST", "MWP:TEST")
    assert [p["time"] for p in managed["points"]] == [left, left + 60000, left + 240000]
    assert managed["points"][-1]["gap_before"]
    assert provider["points"] == []


def test_max_dst_window_remains_bounded_and_ready(database, monkeypatch):
    now = stamp("2026-11-01T21:59:59+00:00")
    left, right = sparklines.window(now, "forex")
    monkeypatch.setattr(storage, "now_ms", lambda: now)
    with database.begin() as db:
        catalog(db, asset="CURRENCY")
    meta = provider_chart.metadata("TEST", cached_only=True)
    with database.begin() as db:
        provider_rows(db, meta, "M1", range(left, right, 60000))
    item = read("MWP:TEST")[0]
    assert item["status"] == "ready" and len(item["points"]) == 1500 <= sparklines.MAX_POINTS
    assert item["window_end"] - item["window_start"] == 25 * 3600000


def test_fixed_history_composite_revision_and_snapshot_observations(database, monkeypatch):
    from alerts.composite_inputs import apply_minutes
    from alerts.confirmed_minutes import record
    from alerts.market_contracts import DatasetIdentity
    from alerts.storage import ObservedMinute, RealtimeMapping
    from test_market_contracts import batch, minute

    revision_id = ready(database, monkeypatch)
    now = 172980000
    monkeypatch.setattr(storage, "now_ms", lambda: now)
    with database.begin() as db:
        revision = db.get(CompositeRevision, revision_id)
        composite_id, version_id, seam = revision.composite_id, revision.history_version_id, revision.seam
        target = db.get(MarketDataset, db.get(RealtimeMapping, revision.mapping_id).target_dataset_id)
        source = DatasetIdentity.model_validate(target.identity)
        apply_minutes(db, record(db, batch(identity=source, window_start=seam, window_end=now,
            checkpoint=now, observed_at=now, volume_kind="price_count", volume_unit="quotes",
            rows=(minute(seam, volume="3"),))))
        db.add(ObservedMinute(dataset_id=target.id, start=seam + 60000, epoch="test-epoch",
            sequence=1, observed_at=169000000, content={**minute(seam + 60000, close="1.12", complete=False).model_dump(),
                "start": seam + 60000, "end": seam + 120000}))
    historical, combined = read("MWH:" + version_id, "MWC:" + composite_id)
    # This UTC window starts on day 2; the fixed snapshot has two real M1 prices.
    assert historical["status"] == "partial" and len(historical["points"]) == 2
    assert combined["revision"] == {"composite_revision_id": revision_id, "input_revision": 1}
    assert combined["status"] == "empty"  # No previous-day seam/tail is reused.
    monkeypatch.setattr(storage, "now_ms", lambda: 170000000)
    combined = sparklines.batch([SparklineItem(ticker="MWC:" + composite_id,
        composite_revision_id=revision_id)])["items"][0]
    assert [p["price"] for p in combined["points"]] == ["1.11", "1.12"]
    assert combined["status"] == "partial"
    wrong, valid = sparklines.batch([SparklineItem(ticker="MWC:" + composite_id,
        composite_revision_id="ffffffff-ffff-ffff-ffff-ffffffffffff"), SparklineItem(ticker="MWH:" + version_id)])["items"]
    assert wrong["status"] == "unavailable" and valid["status"] != "unavailable"


def test_corrupt_history_is_item_failure_without_erasing_other_results(database, monkeypatch):
    revision_id = ready(database, monkeypatch)
    monkeypatch.setattr(storage, "now_ms", lambda: 172980000)
    with database.begin() as db:
        version_id = db.get(CompositeRevision, revision_id).history_version_id
        chunk = db.scalar(select(HistoryChunk).where(HistoryChunk.version_id == version_id))
        # Bypass the immutable ORM writer guard to simulate corrupted storage.
        db.execute(update(HistoryChunk).where(HistoryChunk.id == chunk.id).values(checksum="0" * 64))
    bad, cold = read("MWH:" + version_id, "UNREGISTERED")
    assert bad["status"] == "unavailable" and cold["status"] == "empty"


def test_cold_warm_budget_no_network_no_mutations_or_task_growth(database, monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("sparkline attempted acquisition, demand or supplier network")

    now = stamp("2026-11-11T00:02:00+00:00")
    monkeypatch.setattr(storage, "now_ms", lambda: now)
    with database.begin() as db:
        catalog(db)
    meta = provider_chart.metadata("TEST", cached_only=True)
    with database.begin() as db:
        provider_rows(db, meta, "M1", [now - 120000, now - 60000])
    for name in ("ensure", "read", "native_read"):
        monkeypatch.setattr(provider_cache, name, forbidden)
    monkeypatch.setattr(httpx.Client, "send", forbidden)
    monkeypatch.setattr(httpx.AsyncClient, "send", forbidden)
    with database() as db:
        engine = db.get_bind()
        def counts():
            return {table.name: db.scalar(select(func.count()).select_from(table))
                    for table in storage.Base.metadata.sorted_tables}
        before = counts()
    statements = []
    def observe(conn, cursor, statement, params, context, many):
        statements.append(statement)
        assert statement.lstrip().upper().startswith("SELECT"), statement
    event.listen(engine, "before_cursor_execute", observe)
    try:
        for ticker, budget in (("UNREGISTERED", 2), ("MWP:TEST", 6)):
            statements.clear()
            item = read(ticker)[0]
            assert item["status"] in ("empty", "ready")
            assert len(statements) <= budget, len(statements)
        statements.clear()
        read(*(["MWP:TEST"] * 20))
        assert len(statements) <= 120
    finally:
        event.remove(engine, "before_cursor_execute", observe)
    with database() as db:
        assert counts() == before


def test_history_and_composite_reads_have_no_writes_or_task_growth(database, monkeypatch):
    revision_id = ready(database, monkeypatch)
    monkeypatch.setattr(storage, "now_ms", lambda: 172980000)
    with database() as db:
        version_id = db.get(CompositeRevision, revision_id).history_version_id
        composite_id = db.get(CompositeRevision, revision_id).composite_id
        engine = db.get_bind()
        def counts():
            return {table.name: db.scalar(select(func.count()).select_from(table))
                    for table in storage.Base.metadata.sorted_tables}
        before = counts()
    statements = []
    def observe(conn, cursor, statement, params, context, many):
        statements.append(statement)
        assert statement.lstrip().upper().startswith("SELECT"), statement
    event.listen(engine, "before_cursor_execute", observe)
    try:
        read("MWH:" + version_id, "MWC:" + composite_id)
        assert len(statements) <= 30, len(statements)
    finally:
        event.remove(engine, "before_cursor_execute", observe)
    with database() as db:
        assert counts() == before


def test_provider_current_account_does_not_reuse_other_account_cache(database, monkeypatch):
    from alerts.config import settings
    from alerts.history_catalog import account_scope, oanda_catalog_id

    now = stamp("2026-11-11T00:10:00+00:00")
    monkeypatch.setattr(storage, "now_ms", lambda: now)
    monkeypatch.setattr(settings, "oanda_account_id", "sparkline-first-account")
    with database.begin() as db:
        db.add(MarketCatalog(id=oanda_catalog_id("EUR_USD"), source="oanda", symbol="EUR_USD",
            label="Euro", asset_type="CURRENCY", precision=5, calendar="ny17",
            metadata_json={"history_account_scope": account_scope()}))
    meta = provider_chart.metadata("OANDA:EUR_USD", cached_only=True)
    with database.begin() as db:
        provider_rows(db, meta, "M1", [now - 60000])
    assert read("MWP:OANDA:EUR_USD")[0]["points"]
    monkeypatch.setattr(settings, "oanda_account_id", "sparkline-second-account")
    other = read("MWP:OANDA:EUR_USD")[0]
    assert other["status"] == "unavailable" and other["points"] == []


def test_authenticated_csrf_batch_limit_and_server_owned_window(database):
    with database.begin() as db:
        db.add(LoginSession(token_hash=api.digest("sparkline"), csrf="csrf", expires=storage.now_ms() + 100000))
    with TestClient(api.app) as client:
        path = "/api/market-data/sparklines"
        body = {"items": [{"ticker": "UNREGISTERED"}]}
        assert client.post(path, json=body).status_code == 401
        client.cookies.set("session", "sparkline")
        assert client.post(path, json=body).status_code == 403
        headers = {"x-csrf-token": "csrf"}
        response = client.post(path, json=body, headers=headers)
        assert response.status_code == 200 and response.json()["items"][0]["status"] == "empty"
        assert client.post(path, json={"items": body["items"] * 21}, headers=headers).status_code == 422
        assert client.post(path, json={**body, "start": 0}, headers=headers).status_code == 422
        isolated = client.post(path, json={"items": [{"ticker": "MWH:invalid"}, *body["items"]]}, headers=headers)
        assert [row["status"] for row in isolated.json()["items"]] == ["unavailable", "empty"]
