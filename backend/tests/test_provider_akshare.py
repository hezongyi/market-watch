"""Source truth validation, shared native content and SDK process deadlines."""

import subprocess
import sys
import time

import pytest
from alerts import provider_akshare as source
from alerts.config import settings
from alerts.history_mode_sources import dataset_identity
from alerts.market_contracts import DatasetIdentity, NativeCandleBatch
from alerts.source_history_store import shared_native_page
from test_native_history_archive import day, stamp


def identity(symbol="SZSE:000001", frame="D1"):
    return source.collection_identity(dataset_identity("akshare", symbol, "native_periods", "none"), frame)


@pytest.mark.parametrize("patch", [{"open": "0"}, {"volume": "-1"}, {"close": "14"}])
def test_invalid_prices_volume_and_ranges_are_not_repaired(patch):
    record = {"date": "2024-01-02", "open": "10", "high": "12", "low": "9", "close": "11", "volume": "5", **patch}
    with pytest.raises(ValueError):
        source.parse_records(identity(), [record], start=stamp("2024-01-01"),
            end=stamp("2024-01-04"), observed_at=stamp("2024-01-04"))
    assert source.symbol_rules("HKEX:00700")["code"] == "00700"


def test_source_day_confirmation_uses_each_futures_row():
    data = [{"date": value, "open": "10", "high": "12", "low": "9", "close": "11", "volume": "2"}
            for value in ("2024-01-02", "2024-01-03")]
    rows = source.parse_records(identity("SHFE:RB0"), data, start=stamp("2024-01-01"),
        end=stamp("2024-01-04"), observed_at=stamp("2024-01-04"))
    assert all(row.complete for row in rows)


def test_managed_sina_identity_does_not_reinterpret_legacy_eastmoney():
    parent = DatasetIdentity(source="akshare", channel="python", environment="public",
        account_scope="public", provider_symbol="SZSE:000001", basis="last",
        calendar_version="akshare-source-date-v1", identity_version=2, mode="native_periods",
        base_frame=None, source_family="eastmoney-a", adjustment="none",
        trading_date_rule="supplier-trading-date-v1")
    legacy = source.collection_identity(parent, "D1")
    managed = source.collection_identity(
        dataset_identity("akshare", "SZSE:000001", "native_periods", "none"), "D1")
    assert legacy.parameters["source_family"] == "eastmoney-a"
    assert legacy.parameters["endpoint"] == "stock_zh_a_hist"
    assert managed.parameters["source_family"] == "sina-a"
    assert managed.parameters["endpoint"] == "stock_zh_a_daily"
    assert source.request_parameters(managed, stamp("2024-01-01"), stamp("2024-01-04")) == {
        "symbol": "sz000001", "adjust": ""}


def test_tencent_is_a_separate_platform_only_qfq_identity():
    parent = DatasetIdentity(source="akshare", channel="python", environment="public",
        account_scope="public", provider_symbol="SZSE:000001", basis="last",
        calendar_version="akshare-source-date-v1", identity_version=2, mode="native_periods",
        base_frame=None, source_family="tencent-a", adjustment="none",
        trading_date_rule="supplier-trading-date-v1")
    source_id = source.collection_identity(parent, "D1")
    source_id = source_id.model_copy(update={"parameters": {
        **source_id.parameters, "adjustment": "qfq"}})
    assert source.endpoint("SZSE:000001", "D1", "qfq", "tencent-a") == "stock_zh_a_hist_tx"
    assert source.request_parameters(source_id, stamp("2024-01-01"), stamp("2024-01-04")) == {
        "symbol": "sz000001", "adjust": "qfq", "start_date": "20240101", "end_date": "20240104"}
    assert source_id.key != source.collection_identity(
        dataset_identity("akshare", "SZSE:000001", "native_periods", "none"), "D1").key


@pytest.mark.parametrize(("symbol", "family", "endpoint"), [
    ("SZSE:000001", "sina-a", "stock_zh_a_daily"),
    ("HKEX:00700", "sina-hk", "stock_hk_daily"),
    ("SZSE:000001", "tencent-a", "stock_zh_a_hist_tx"),
])
def test_platform_qfq_request_uses_selected_provider_endpoint(monkeypatch, symbol, family, endpoint):
    parent = dataset_identity("akshare", symbol, "native_periods", "none")
    if family == "tencent-a":
        parent = parent.model_copy(update={"source_family": family})
    identity = source.collection_identity(parent, "D1")
    identity = identity.model_copy(update={"parameters": {
        **identity.parameters, "source_family": family, "adjustment": "qfq",
        "endpoint": source.endpoint(symbol, "D1", "qfq", family)}})
    calls = []
    monkeypatch.setattr(source, "invoke", lambda name, parameters, deadline=None: calls.append(name) or [{
        "日期": "2024-01-02", "开盘": "10", "最高": "12", "最低": "9",
        "收盘": "11", "成交量": "100"}])

    result = source.AKShareHistory().native_page(identity, stamp("2024-01-01"), stamp("2024-01-04"))

    assert calls == [endpoint]
    assert result.rows


def test_platform_catalog_lists_tencent_separately_without_managed_capability(database):
    from alerts.platform_catalog import catalog
    from alerts.storage import MarketCatalog

    with database.begin() as db:
        db.add(MarketCatalog(id="AKSHARE:fixture", source="akshare", symbol="SZSE:000001",
            label="平安银行", asset_type="EQUITY", precision=4, calendar="source_date",
            available=True, metadata_json={"asset_class": "equity", "source_family": "sina-a",
                "verified_frames": {"none": ["D1"]}},
            updated_at=0))
    with database.begin() as db:
        rows = catalog(db, source="akshare", page_size=100)["items"]
    sina = next(row for row in rows if row["id"] == "AKSHARE:fixture")
    tencent = next(row for row in rows if row["id"] == "TENCENT:SZSE:000001")
    assert sina["provider_name"] == "新浪 (AKShare)"
    assert tencent["provider_name"] == "腾讯 (AKShare)"
    assert tencent["capabilities"]["native_periods"] == ["D1"]
    assert tencent["logical_symbol"] is None


@pytest.mark.parametrize("symbol,value", [("SZSE:000001", "2"), ("HKEX:00700", "0.5")])
def test_sina_factor_attachment_keeps_sentinel_as_oldest_basis(symbol, value):
    basis = source.collection_identity(
        dataset_identity("akshare", symbol, "native_periods", "none"), "D1")
    row = day("2024-01-02")
    rows = source.parse_sina_factors([
        {"date": "1900-01-01", "qfq_factor": "1"},
        {"date": "2024-01-02", "qfq_factor": value},
    ], [row])
    assert rows[0].adjustment_basis["value"] == value
    assert rows[0].adjustment_basis["effective_date"] == "2024-01-02"
    assert basis.parameters["source_family"] in ("sina-a", "sina-hk")


def test_identical_native_request_reuses_content_without_second_network(database):
    calls = []

    class Adapter:
        def native_page(self, identity, start, end):
            calls.append((start, end))
            return NativeCandleBatch(identity=identity, timeframe="D1", window_start=start, window_end=end,
                observed_at=end, checkpoint=end, rows=[day("2024-01-02")], result={"status": "data"},
                volume_kind="quantity", volume_unit="lots")

    kwargs = {"fresh_after": 0, "volume_kind": "quantity", "volume_unit": "lots"}
    first = shared_native_page(Adapter(), identity(), stamp("2024-01-01"), stamp("2024-01-04"), **kwargs)
    second = shared_native_page(Adapter(), identity(), stamp("2024-01-01"), stamp("2024-01-04"), **kwargs)
    assert first == second and len(calls) == 1


def test_deadline_kills_and_reaps_sdk_process_before_releasing_slot(database, monkeypatch):
    monkeypatch.setattr(settings, "akshare_enabled", True)
    real = subprocess.Popen
    children = []

    def slow(*args, **kwargs):
        child = real([sys.executable, "-c", "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(20)"], **kwargs)
        children.append(child)
        return child

    monkeypatch.setattr(source.subprocess, "Popen", slow)
    with pytest.raises(TimeoutError):
        source.invoke("stock_zh_a_hist", {}, deadline=time.monotonic() + 0.4)
    assert children and children[0].poll() is not None


@pytest.mark.parametrize('records', [
    [{'date': '1900-01-01', 'qfq_factor': 'bad'}],
    [{'date': '1900-01-01', 'qfq_factor': '0'}],
    [{'date': '1900-01-01', 'qfq_factor': 'NaN'}],
    [{'date': '2024-01-01', 'qfq_factor': '1'}, {'date': '2024-01-01', 'qfq_factor': '2'}],
])
def test_invalid_factor_snapshot_is_not_silently_repaired(records):
    with pytest.raises(ValueError):
        source.parse_sina_factors(records, [day('2024-01-02')])


def test_factor_failure_preserves_raw_observations(monkeypatch):
    def invoke(name, parameters, deadline=None):
        if parameters['adjust'] == 'qfq-factor':
            raise TimeoutError('source unavailable')
        return [{'date': '2024-01-02', 'open': '10', 'high': '12', 'low': '9', 'close': '11', 'volume': '100'}]
    monkeypatch.setattr(source, 'invoke', invoke)
    batch = source.AKShareHistory().native_page(identity(), stamp('2024-01-01'), stamp('2024-01-04'))
    assert batch.rows[0].close == '11' and batch.rows[0].adjustment_basis is None


def test_platform_cache_separates_source_and_adjustment():
    from alerts.provider_cache import identity as cache_identity
    meta = {'source': 'akshare', 'symbol': 'SZSE:000001', 'basis': 'last',
        'calendar': 'source_date', 'source_family': 'sina-a', 'adjustment': 'qfq'}
    assert len({cache_identity(meta, 'D1'), cache_identity({**meta, 'source_family': 'tencent-a'}, 'D1'),
        cache_identity({**meta, 'adjustment': 'none'}, 'D1')}) == 3


def test_tencent_never_appears_for_hk_and_metadata_matches_catalog(database, monkeypatch):
    from alerts.akshare_catalog import seed, stable_id
    from alerts.platform_catalog import catalog
    from alerts.provider_chart import metadata
    monkeypatch.setattr(settings, 'akshare_enabled', True)
    seed()
    with database.begin() as db:
        rows = catalog(db, source='akshare', page_size=100)['items']
    assert not any(row['id'] == 'TENCENT:HKEX:00700' for row in rows)
    sina, tx = metadata(stable_id('SZSE:000001')), metadata('TENCENT:SZSE:000001')
    assert sina['source_family'] == 'sina-a' and sina['volume_unit'] == 'shares'
    assert tx['source_family'] == 'tencent-a' and tx['frames'] == ['D1']
    assert sina['adjustment'] == tx['adjustment'] == 'qfq'
    with pytest.raises(ValueError):
        metadata('TENCENT:HKEX:00700')


@pytest.mark.parametrize("instrument", ["AKSHARE:abc", "TENCENT:SZSE:000001", "MWP:TENCENT:SZSE:000001"])
def test_chart_wait_uses_akshare_sdk_budget(monkeypatch, instrument):
    import asyncio

    from alerts import chart_api, provider_capabilities
    budgets = []
    monkeypatch.setattr(provider_capabilities, "request_seconds", lambda source: budgets.append(source) or 1)
    monkeypatch.setattr(chart_api, "data_sync", lambda body: {"bars": []})
    asyncio.run(chart_api.query_chart(chart_api.DataQuery(instrument=instrument, series_kind="provider", timeframe="D1")))
    assert budgets == ["akshare"]


def test_hk_decoder_precision_dust_keeps_original_evidence_and_rejects_real_anomaly():
    record = {"date": "2024-03-11", "open": "271.2", "high": "278.6", "low": "271.2", "close": "278.60001", "volume": "17866889"}
    rows = source.parse_records(identity("HKEX:00700"), [record], start=stamp("2024-01-01"), end=stamp("2025-01-01"), observed_at=stamp("2025-01-01"))
    assert rows[0].close == "278.6000"
    assert rows[0].source_ohlc["close"] == "278.60001"
    assert rows[0].price_normalization == "sina-hk-decoder-dust-4dp-v1"
    with pytest.raises(ValueError):
        source.parse_records(identity("HKEX:00700"), [{**record, "close": "278.61"}], start=stamp("2024-01-01"), end=stamp("2025-01-01"), observed_at=stamp("2025-01-01"))


def test_platform_coverage_reaches_requested_subminute_cutoff(monkeypatch):
    from types import SimpleNamespace

    from alerts import source_history_store
    before = stamp("2024-01-05") + 12345
    row = source.parse_records(identity(), [{"date": "2024-01-02", "open": "10", "high": "12", "low": "9", "close": "11", "volume": "5"}], start=stamp("2024-01-01"), end=before, observed_at=before)[0]
    monkeypatch.setattr(source, "now_ms", lambda: before)
    monkeypatch.setattr(source_history_store, "shared_native_page", lambda *a, **kw: SimpleNamespace(rows=[row], observed_at=before))
    page = source.platform_page({"symbol": "SZSE:000001", "source_family": "sina-a", "frames": ["D1"], "volume_unit": "shares", "precision": 4}, "D1", before, 10)
    assert page["coverage"][-1][-1] == before


def test_persisted_v1_source_can_continue_maintenance_without_reinterpreting_hk(monkeypatch):
    old = identity("SHFE:RB0").model_copy(update={"parameters": {**identity("SHFE:RB0").parameters, "rules": source.LEGACY_RULES}})
    record = {"date": "2024-01-02", "open": "10", "high": "12", "low": "9", "close": "11", "volume": "5"}
    monkeypatch.setattr(source, "invoke", lambda *a, **kw: [record])
    batch = source.AKShareHistory().native_page(old, stamp("2024-01-01"), stamp("2024-01-04"))
    assert batch.identity == old and batch.rows[0].close == "11"
    hk = identity("HKEX:00700").model_copy(update={"parameters": {**identity("HKEX:00700").parameters, "rules": source.LEGACY_RULES}})
    with pytest.raises(ValueError):
        source.parse_records(hk, [{**record, "high": "11", "close": "11.00001"}], start=stamp("2024-01-01"), end=stamp("2024-01-04"), observed_at=stamp("2024-01-04"))


def test_native_chart_uppercases_hashed_sina_ticker_without_losing_catalog_identity(database, monkeypatch):
    from alerts.akshare_catalog import seed, stable_id
    from alerts.chart_series import decode
    from alerts.provider_chart import metadata
    monkeypatch.setattr(settings, "akshare_enabled", True)
    seed()
    ident = stable_id("SZSE:000001")
    assert decode(("MWP:" + ident).upper()) == (ident, "provider")
    assert metadata(ident.upper())["id"] == ident
    assert metadata(ident.upper())["source_family"] == "sina-a"


def test_daily_platform_quote_uses_daily_source_without_minute_requests(monkeypatch):
    from alerts import provider_chart
    calls = []
    monkeypatch.setattr(provider_chart, "cached_page", lambda meta, frame, before, count, **kw: calls.append((frame, count)) or {"bars": [{"close": "11", "start": stamp("2024-01-02")}], "as_of": 10})
    meta = {"source": "akshare", "symbol": "SZSE:000001", "id": "daily-quote-fixture", "basis": "last", "calendar": "source_date"}
    assert provider_chart.quote_page(meta)["bars"][0]["close"] == "11"
    assert provider_chart.quote_previous_close(meta, {"start": stamp("2024-01-03")}) == 11
    assert calls == [("D1", 1), ("D1", 1)]
