"""Cross-day selection is independent of known source trading-session state."""
import pytest
from alerts import provider_chart, sparklines, storage
from alerts.sparkline_api import SparklineItem
from test_sparklines import catalog, provider_rows, read, stamp
from test_sparkline_sessions import META


@pytest.mark.parametrize("asset,now,previous", [
    ("CURRENCY", "2026-11-13T22:01:00+00:00", "2026-11-13T21:59:00+00:00"),
    ("METAL", "2026-11-16T12:00:00+00:00", "2026-11-13T21:59:00+00:00"),
    ("CRYPTO", "2026-11-14T00:00:30+00:00", "2026-11-13T23:59:00+00:00"),
])
def test_native_latest_actual_window_and_first_current_point(database, monkeypatch, asset, now, previous):
    now, previous = stamp(now), stamp(previous)
    monkeypatch.setattr(storage, "now_ms", lambda: now)
    with database.begin() as db:
        catalog(db, asset=asset)
    meta = provider_chart.metadata("TEST", cached_only=True)
    with database.begin() as db:
        key = provider_rows(db, meta, "M1", [previous])
    item = read("MWP:TEST")[0]
    assert item["points"][0]["time"] == previous
    assert item["display_state"] == "previous"
    assert item["session"]["previous"]
    assert item["target_window_start"] > item["window_start"]
    assert item["valid_until"] > now and item["next_check_at"] > now
    assert item["session_open_price"] is None, "a late cached point is not the open"
    left = item["target_window_start"]
    from alerts.storage import ProviderBar
    with database.begin() as db:
        db.add(ProviderBar(dataset_id=key, start=left, chart_time=left, complete=True,
            payload={"start": left, "end": left + 60000, "close": "2", "open": "1", "complete": True}, observed_at=now))
    current = read("MWP:TEST")[0]
    assert not current["session"]["previous"]
    assert len(current["points"]) == 1 and current["points"][0]["price"] == "2"


@pytest.mark.parametrize("end,now,state", [
    ("2026-11-13T21:00:00+00:00", "2026-11-13T20:59:59+00:00", "current"),
    ("2026-11-13T21:00:00+00:00", "2026-11-13T21:00:00+00:00", "closed"),
    ("2026-11-27T18:00:00+00:00", "2026-11-27T18:00:00+00:00", "closed"),
])
def test_source_regular_session_closes_without_waiting_midnight(database, monkeypatch, end, now, state):
    date = now[:10]
    opening = stamp(date + "T14:30:00+00:00")
    meta = {**META, "sparkline_sessions": {date: {"start": opening, "end": stamp(end)}}}
    monkeypatch.setattr(storage, "now_ms", lambda: stamp(now))
    monkeypatch.setattr(provider_chart, "metadata", lambda *args, **kwargs: meta)
    with database.begin() as db:
        provider_rows(db, meta, "M1", [opening])
    item = read("MWP:NVDA")[0]
    assert not item["session"]["previous"], "same trading date is not yesterday"
    assert item["display_state"] == state
    assert item["window_end"] == stamp(end)


def test_missing_session_evidence_is_unknown_not_guessed_closed(database, monkeypatch):
    monkeypatch.setattr(storage, "now_ms", lambda: stamp("2026-11-13T21:00:00+00:00"))
    monkeypatch.setattr(provider_chart, "metadata", lambda *args, **kwargs: META)
    with database.begin() as db:
        provider_rows(db, META, "M1", [stamp("2026-11-13T14:30:00+00:00")])
    assert read("MWP:NVDA")[0]["display_state"] == "unknown"


def test_successful_empty_prepare_is_retryable(database, monkeypatch):
    from alerts import provider_cache
    monkeypatch.setattr(storage, "now_ms", lambda: stamp("2026-11-13T21:00:00+00:00"))
    monkeypatch.setattr(provider_chart, "metadata", lambda *args, **kwargs: META)
    monkeypatch.setattr(provider_cache, "read", lambda *args, **kwargs: {})
    assert sparklines.prepare(SparklineItem(ticker="MWP:NVDA"))["preparation"] == "retry"


def test_source_period_parser_preserves_early_close_and_exchange_date():
    from alerts.sparkline_calendar import source_sessions
    opening, end = stamp("2026-11-27T14:30:00+00:00"), stamp("2026-11-27T18:00:00+00:00")
    periods = source_sessions(META, {"currentTradingPeriod": {"regular": {"start": opening // 1000, "end": end // 1000},
        "post": {"start": end // 1000, "end": end // 1000 + 3600}}, "tradingPeriods": {"regular": []}})
    assert periods == {"2026-11-27": {"start": opening, "end": end}}
    assert source_sessions(META, {"currentTradingPeriod": {"regular": {"start": 0, "end": "bad"}}}) == {}


def test_calendar_preparation_is_bounded_and_does_not_write_prices(database, monkeypatch):
    from alerts import provider_yahoo
    from alerts.sparkline_calendar import refresh
    from alerts.storage import MarketCatalog, ProviderBar
    from sqlalchemy import func, select
    now = stamp("2026-11-27T17:00:00+00:00")
    sessions = {"2026-11-27": {"start": stamp("2026-11-27T14:30:00+00:00"), "end": stamp("2026-11-27T18:00:00+00:00")}}
    calls = []
    with database.begin() as db:
        db.add(MarketCatalog(id="NVDA", source="yahoo", symbol="NVDA", label="英伟达", asset_type="EQUITY", precision=2, metadata_json={"preserve": True}))
    monkeypatch.setattr(provider_yahoo, "regular_sessions", lambda *args: calls.append(True) or sessions)
    refresh("NVDA", META, now)
    refresh("NVDA", META, now + 1000)
    assert len(calls) == 1
    with database() as db:
        data = db.get(MarketCatalog, "NVDA").metadata_json
        assert data["sparkline_sessions"] == sessions and data["preserve"]
        assert db.scalar(select(func.count()).select_from(ProviderBar)) == 0


def test_calendar_failure_remains_unknown_with_a_retry_deadline(database, monkeypatch):
    from alerts import provider_yahoo
    from alerts.sparkline_calendar import refresh
    from alerts.storage import MarketCatalog
    now = stamp("2026-11-13T21:00:00+00:00")
    calls = []
    def fail(*args):
        calls.append(True)
        raise TimeoutError()
    monkeypatch.setattr(provider_yahoo, "regular_sessions", fail)
    with database.begin() as db:
        db.add(MarketCatalog(id="NVDA", source="yahoo", symbol="NVDA", label="英伟达", asset_type="EQUITY", precision=2))
    refresh("NVDA", META, now)
    refresh("NVDA", META, now + 1000)
    assert len(calls) == 1
    with database() as db:
        data = db.get(MarketCatalog, "NVDA").metadata_json
        assert not data["sparkline_sessions"]
        assert data["sparkline_calendar_retry_at"] == now + 900000


def test_daily_only_is_explicitly_unsupported_for_intraday(database, monkeypatch):
    meta = {**META, "frames": ["D1"]}
    monkeypatch.setattr(provider_chart, "metadata", lambda *args, **kwargs: meta)
    monkeypatch.setattr(storage, "now_ms", lambda: stamp("2026-11-13T21:00:00+00:00"))
    item = read("MWP:NVDA")[0]
    assert item["points"] == [] and item["display_state"] == "unsupported"
    assert sparklines.prepare(SparklineItem(ticker="MWP:NVDA"))["preparation"] == "unsupported"


def test_old_fixed_version_retains_its_identity_with_visible_history_semantics(database, monkeypatch):
    from test_composite_preparation import ready
    from alerts.storage import CompositeRevision
    revision = ready(database, monkeypatch)
    with database() as db:
        version = db.get(CompositeRevision, revision).history_version_id
    monkeypatch.setattr(storage, "now_ms", lambda: 40 * 86400000)
    item = read("MWH:" + version)[0]
    assert item["points"] and item["display_state"] == "historical"
    assert item["revision"]["history_version_id"] == version
    assert item["session"]["previous"] and item["session"]["date"]


def test_fixed_calendar_comes_from_immutable_manifest():
    from types import SimpleNamespace
    dataset = SimpleNamespace(instrument_id="fixed", asset_class="stock", identity={})
    version = SimpleNamespace(manifest={"aggregation_calendar": "ny17"})
    db = SimpleNamespace(get=lambda *args: SimpleNamespace(calendar="utc0"))
    now = stamp("2026-11-13T22:01:00+00:00")
    bounds = sparklines.dataset_bounds(db, dataset, now, version=version)
    assert bounds(now)[0] == stamp("2026-11-13T22:00:00+00:00")


def test_reclaimed_fixed_version_is_unavailable_not_empty(database, monkeypatch):
    from alerts.storage import CompositeRevision, HistoryReclamation
    from test_composite_preparation import ready
    revision = ready(database, monkeypatch)
    with database.begin() as db:
        version_id = db.get(CompositeRevision, revision).history_version_id
        db.add(HistoryReclamation(version_id=version_id, request_id="fixture", reclaimed_at=200010000))
    item = read("MWH:" + version_id)[0]
    assert item["status"] == "unavailable" and not item["points"]
    assert "已回收" in item["reason"]


def test_source_date_bounds_use_exchange_timezone_and_dst():
    from types import SimpleNamespace
    # This pure lookup exercises a real dataset identity, without fabricating prices.
    dataset = SimpleNamespace(instrument_id="test", asset_class="stock", identity={"parameters": {"timezone": "America/New_York"}})
    version = SimpleNamespace(manifest={"aggregation_calendar": "source_date"})
    db = SimpleNamespace(get=lambda *args: SimpleNamespace(calendar="utc0"))
    bounds = sparklines.dataset_bounds(db, dataset, 0, version=version)
    for date, hours in (("2026-03-08T12:00:00+00:00", 23), ("2026-11-01T12:00:00+00:00", 25)):
        left, right = bounds(stamp(date))
        assert right - left == hours * 3600000
        assert left < stamp(date) < right


def test_source_transport_keeps_valid_meta_when_sdk_has_no_prices(monkeypatch):
    from contextlib import contextmanager
    from types import SimpleNamespace
    from alerts import provider_yahoo
    from yfinance.exceptions import YFPricesMissingError
    opening, end = stamp("2026-11-27T14:30:00+00:00"), stamp("2026-11-27T18:00:00+00:00")
    session = SimpleNamespace(chart_response=(200, {"chart": {"result": [{"meta": {
        "currentTradingPeriod": {"regular": {"start": opening // 1000, "end": end // 1000}}
    }}]}}))
    @contextmanager
    def operation(*args, **kwargs):
        yield session
    def missing(*args, **kwargs):
        raise YFPricesMissingError("NVDA", "fixture empty")
    monkeypatch.setattr(provider_yahoo, "_operation", operation)
    monkeypatch.setattr(provider_yahoo.yf, "Ticker", lambda *args, **kwargs: object())
    monkeypatch.setattr(provider_yahoo, "_history", missing)
    assert provider_yahoo.regular_sessions(META, end) == {"2026-11-27": {"start": opening, "end": end}}
    session.chart_response = (200, {"chart": {"result": None}})
    assert provider_yahoo.regular_sessions(META, end) == {}


def test_managed_cache_rolls_from_previous_day_to_first_current_bar(database, monkeypatch):
    from decimal import Decimal
    from alerts.storage import Bar
    now = stamp('2026-11-14T00:01:00+00:00')
    left = stamp('2026-11-14T00:00:00+00:00')
    monkeypatch.setattr(storage, 'now_ms', lambda: now)
    def bar(at):
        return Bar(instrument_id='TEST', timeframe='M1', start=at, end=at + 60000,
            open=Decimal('2'), high=Decimal('2'), low=Decimal('2'), close=Decimal('2'), complete=True)
    with database.begin() as db:
        catalog(db)
        db.add(bar(left - 60000))
    previous = read('TEST')[0]
    assert previous['session']['previous'] and previous['points'][0]['time'] == left - 60000
    with database.begin() as db:
        db.add(bar(left))
    current = read('TEST')[0]
    assert not current['session']['previous'] and len(current['points']) == 1
    assert current['session_open_price'] == '2.0000000000'


def test_composite_previous_window_and_first_current_observation(database, monkeypatch):
    from alerts.storage import CompositeRevision, MarketDataset, ObservedMinute, RealtimeMapping
    from test_composite_preparation import ready
    from test_market_contracts import minute
    revision_id = ready(database, monkeypatch)
    now = 300010000
    monkeypatch.setattr(storage, 'now_ms', lambda: now)
    with database() as db:
        revision = db.get(CompositeRevision, revision_id)
        ticker = 'MWC:' + revision.composite_id
        target_id = db.get(RealtimeMapping, revision.mapping_id).target_dataset_id
    previous = read(ticker)[0]
    assert previous['session']['previous'] and previous['points']
    assert previous['revision']['composite_revision_id'] == revision_id
    left = previous['target_window_start']
    with database.begin() as db:
        db.add(ObservedMinute(dataset_id=target_id, start=left, epoch='fixture', sequence=1,
            observed_at=now, content={**minute(left, close='1.12', complete=False).model_dump(),
                'start': left, 'end': left + 60000}))
    current = read(ticker)[0]
    assert not current['session']['previous'] and len(current['points']) == 1
    assert current['points'][0]['price'] == '1.12'
    assert current['revision']['composite_revision_id'] == revision_id


def test_active_revision_switch_never_reuses_another_revision_tail(database, monkeypatch):
    from alerts.composite_revisions import activate, create
    from alerts.storage import CompositeRevision
    from test_composite_revisions import request, prepared
    composite_id, old, body = request(database, monkeypatch)
    with database.begin() as db:
        new = create(db, composite_id, body).id
    prepared(database, new)
    monkeypatch.setattr(storage, 'now_ms', lambda: 200010000)
    explicit_old = sparklines.batch([SparklineItem(ticker='MWC:' + composite_id, composite_revision_id=old)])['items'][0]
    with database.begin() as db:
        activate(db, composite_id, new, {'request_id': 'sparkline-activation', 'expected_revision_id': old})
    active = read('MWC:' + composite_id)[0]
    assert active['status'] != 'unavailable' and active['revision']['composite_revision_id'] == new
    still_old = sparklines.batch([SparklineItem(ticker='MWC:' + composite_id, composite_revision_id=old)])['items'][0]
    assert still_old == explicit_old, 'activation cannot rewrite a pinned old sparkline'


def test_provider_revalidation_changes_cache_identity_even_when_empty(database, monkeypatch):
    from alerts.storage import ProviderBar, ProviderDataset
    from sqlalchemy import delete
    now = stamp('2026-11-13T12:00:00+00:00')
    monkeypatch.setattr(storage, 'now_ms', lambda: now)
    with database.begin() as db:
        catalog(db)
    meta = provider_chart.metadata('TEST', cached_only=True)
    with database.begin() as db:
        key = provider_rows(db, meta, 'M1', [now - 60000])
    old = read('MWP:TEST')[0]
    with database.begin() as db:
        dataset = db.get(ProviderDataset, key)
        dataset.metadata_json = {**dataset.metadata_json, 'revalidation_generation': 3}
        db.execute(delete(ProviderBar).where(ProviderBar.dataset_id == key))
    new = read('MWP:TEST')[0]
    assert not new['points'] and old['identity_key'] != new['identity_key']


def test_native_daily_open_fills_sparse_minutes_without_borrowing_another_source_day(database, monkeypatch):
    from alerts.storage import ProviderBar
    now = stamp('2026-11-13T23:00:00+00:00')
    left = stamp('2026-11-12T22:00:00+00:00')
    monkeypatch.setattr(storage, 'now_ms', lambda: now)
    with database.begin() as db:
        catalog(db, asset='CURRENCY')
    meta = provider_chart.metadata('TEST', cached_only=True)
    with database.begin() as db:
        provider_rows(db, meta, 'M1', [left + 240000], price='1.2')
        daily_key = provider_rows(db, meta, 'D1', [left], price='1.3')
        day = db.get(ProviderBar, (daily_key, left))
        day.payload = {**day.payload, 'open': '1.1', 'end': left + 86400000}
    assert read('MWP:TEST')[0]['session_open_price'] == '1.1'
    with database.begin() as db:
        day = db.get(ProviderBar, (daily_key, left))
        day.payload = {**day.payload, 'end': left + 3600000}
    assert read('MWP:TEST')[0]['session_open_price'] is None


def test_prepare_failed_history_is_explicit_not_empty_success(database, monkeypatch):
    from alerts import provider_cache
    now = stamp('2026-11-13T23:00:00+00:00')
    monkeypatch.setattr(storage, 'now_ms', lambda: now)
    with database.begin() as db:
        catalog(db)
    def fail(*args, **kwargs):
        raise TimeoutError('test supplier failure')
    monkeypatch.setattr(provider_cache, 'read', fail)
    response = sparklines.prepare(SparklineItem(ticker='MWP:TEST'))
    assert response['preparation'] == 'retry'
    assert response['items'][0]['preparation_error'] == '历史补取暂未成功，稍后重试'
    assert not response['items'][0]['points']


def test_prepare_sparse_oanda_requests_one_matching_native_daily_open(database, monkeypatch):
    from alerts import provider_cache
    from alerts.storage import ProviderBar
    now = stamp('2026-11-14T00:00:00+00:00')
    left = stamp('2026-11-12T22:00:00+00:00')
    monkeypatch.setattr(storage, 'now_ms', lambda: now)
    with database.begin() as db:
        catalog(db, asset='CURRENCY')
    meta = {**provider_chart.metadata('TEST', cached_only=True), 'source':'oanda', 'symbol':'USD_CAD', 'calendar':'ny17', 'frames':['M1','D1']}
    monkeypatch.setattr(provider_chart, 'metadata', lambda *args, **kwargs: meta)
    with database.begin() as db:
        provider_rows(db, meta, 'M1', [left + 240000], price='1.4')
    from test_provider_cache import seed
    label = stamp('2026-11-13T00:00:00+00:00')
    def daily(at, chart_time, opening):
        return {'bars':[{'start':at, 'end':at+86400000, 'chart_time':chart_time,
            'open':opening, 'high':'1.5', 'low':'1.3', 'close':'1.4', 'complete':True}], 'history_boundary':False}
    key = seed(meta, 'D1', label, daily(left-86400000, label-86400000, '1.38'))
    assert provider_cache.snapshot(key, label+1, 1)['satisfied'], 'reproduce the older-day cache hit'
    calls = []
    monkeypatch.setattr(provider_cache, 'read', lambda *args, **kwargs: None)
    def fetch(meta, frame, before, count, **kwargs):
        calls.append((frame, before, count))
        assert frame == 'D1' and before == label+1 and count == 1
        return daily(left, label, '1.39')
    monkeypatch.setattr(provider_chart, 'native_page', fetch)
    result = sparklines.prepare(SparklineItem(ticker='MWP:TEST'))
    assert calls == [('D1', label+1, 1)]
    assert result['items'][0]['session_open_price'] == '1.39'
    assert result['items'][0]['timeframe'] == 'M1' and len(result['items'][0]['points']) == 1
