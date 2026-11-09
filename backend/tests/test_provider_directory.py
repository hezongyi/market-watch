"""Provider directory is local-first, scoped and independent from history demand."""

from alerts.catalog_sync import describe, publish
from alerts.instrument_directory import search
from alerts.storage import MarketCatalog, MarketDataset, MarketDemand
from sqlalchemy import select


def test_catalog_search_pages_long_codes_and_preserves_manual_chinese_name(database):
    records = [{"id": "BINANCE:" + symbol, "symbol": symbol, "label": "Solana / USDT",
        "asset_type": "CRYPTO", "precision": 4, "calendar": "utc0",
        "metadata_json": {"exchange": "Binance Spot"}}
        for symbol in ("SOLUSDT", "SUPERLONGASSETUSDT")]
    publish("binance", records, complete=True, advertised_total=2, origin="fixture")
    with database.begin() as db:
        row = db.scalar(select(MarketCatalog).where(MarketCatalog.symbol == "SOLUSDT"))
        describe(db, row.id, "索拉纳 / USDT")
        page = search(db, source="binance", query="SUPERLONGASSETUSDT", limit=1)
        assert page["total"] == 1
        assert page["items"][0]["provider_symbol"] == "SUPERLONGASSETUSDT"
        assert search(db, source="binance", query="索拉纳")["items"][0]["name_zh"] == "索拉纳 / USDT"
        assert db.scalar(select(MarketDataset.id)) is None
        assert db.scalar(select(MarketDemand.id)) is None


def test_partial_directory_refresh_keeps_previous_snapshot(database):
    records = [{"id": "BINANCE:BTCUSDT", "symbol": "BTCUSDT", "label": "BTC / USDT",
        "asset_type": "CRYPTO", "precision": 2, "calendar": "utc0"}]
    publish("binance", records, complete=True, advertised_total=1, origin="fixture")
    with database.begin() as db:
        assert search(db, source="binance", query="BTC")["total"] == 1
        row = db.get(MarketCatalog, "BINANCE:BTCUSDT")
        assert row.available


def test_yahoo_exclusion_and_akshare_legacy_scope_apply_to_all_local_searches(database, monkeypatch):
    from alerts.config import settings
    monkeypatch.setattr(settings, "yahoo_enabled", True)
    monkeypatch.setattr(settings, "akshare_enabled", True)
    for source, symbols in (("yahoo", ["AAPL", "0700.HK", "600000.SS", "000001.SZ", "920001.BJ"]),
                            ("akshare", ["SZSE:000001", "BSE:920001", "SHFE:RB0", "SHFE:RB2612", "SHFE:RB2610"])):
        publish(source, [{"id": source + symbol, "symbol": symbol, "label": symbol,
            "asset_type": "FUTURE" if symbol.startswith("SHFE:") else "EQUITY"} for symbol in symbols])
    for managed in (True, False):
        with database() as db:
            assert [r["symbol"] for r in search(db, source="yahoo", managed=managed)["items"]] == ["AAPL"]
            symbols = {r["symbol"] for r in search(db, source="akshare", managed=managed)["items"]}
            assert symbols == {"SZSE:000001", "SHFE:RB0"}
    import pytest
    from alerts.akshare_catalog import get_details, stable_id
    publish("akshare", [{"id": stable_id("HKEX:02800"), "symbol": "HKEX:02800",
        "label": "盈富基金", "asset_type": "ETF"}])
    with database() as db:
        assert not search(db, source="akshare", query="02800")["items"]
        with pytest.raises(ValueError, match="仅支持股票"):
            get_details(db, "HKEX:02800")


def test_failed_refresh_and_missing_rows_preserve_snapshot_and_manual_description(database, monkeypatch):
    import pytest
    from alerts import catalog_sync
    record = {"id": "BINANCE:AAA", "symbol": "AAA", "label": "Original", "asset_type": "CRYPTO"}
    publish("binance", [record], complete=True)
    with database.begin() as db:
        describe(db, record["id"], "人工名称")
    publish("binance", [{**record, "label": "New supplier name"}], complete=True)
    monkeypatch.setattr(catalog_sync, "refresh_binance", lambda: (_ for _ in ()).throw(TimeoutError()))
    with pytest.raises(TimeoutError):
        catalog_sync.refresh("binance")
    with database() as db:
        assert db.get(MarketCatalog, record["id"]).metadata_json["name_zh"] == "人工名称"
        state = catalog_sync.statuses(db, "binance")[0]
        assert state["last_success"] and state["status"] == "failed" and state["count"] == 1
    publish("binance", [{**record, "id": "BINANCE:BBB", "symbol": "BBB"}], complete=True, mark_missing=True)
    with database() as db:
        assert db.get(MarketCatalog, record["id"]).available is False


def test_akshare_existing_directory_refresh_filters_beijing_and_keeps_probes(database, monkeypatch):
    from alerts import akshare_catalog as catalog
    from alerts.config import settings
    monkeypatch.setattr(settings, "akshare_enabled", True)
    symbol = "SZSE:000001"
    publish("akshare", [{"id": catalog.stable_id(symbol), "symbol": symbol, "label": "Old",
        "asset_type": "EQUITY", "metadata_json": {**catalog.details(symbol),
            "verified_frames": {"none": ["D1"]}, "probes": {"none": {"D1": {"status": "verified"}}}}}])
    with database.begin() as db:
        describe(db, catalog.stable_id(symbol), "我的平安银行")
    calls = []
    def invoke(name, params):
        calls.append(name)
        return [{"code": "000001", "name": "平安银行"}, {"code": "920001", "name": "北交所"}]
    monkeypatch.setattr(catalog, "invoke", invoke)
    assert catalog.refresh("a")["count"] == 1
    assert calls == ["stock_info_a_code_name"]
    with database() as db:
        row = db.get(MarketCatalog, catalog.stable_id(symbol))
        assert row.metadata_json["name_zh"] == "我的平安银行"
        assert row.metadata_json["verified_frames"] == {"none": ["D1"]}
        assert search(db, source="akshare", query="920001")["total"] == 0


def test_transient_probe_failure_keeps_verified_frames_and_manual_metadata(database, monkeypatch):
    from alerts import akshare_catalog as catalog
    from alerts.config import settings
    monkeypatch.setattr(settings, "akshare_enabled", True)
    catalog.seed()
    with database.begin() as db:
        describe(db, catalog.stable_id("SZSE:000001"), "我的银行")
    monkeypatch.setattr(catalog.AKShareHistory, "native_page", lambda *a, **k: (_ for _ in ()).throw(TimeoutError()))
    result = catalog.probe("SZSE:000001", ["D1"])
    assert result["frames"] == ["D1"] and result["results"]["D1"]["status"] == "error"
    with database() as db:
        assert db.get(MarketCatalog, catalog.stable_id("SZSE:000001")).metadata_json["name_zh"] == "我的银行"


def test_yahoo_pages_publish_only_complete_partition(database, monkeypatch):
    import httpx
    from alerts import yahoo_catalog as catalog
    from alerts.catalog_sync import statuses
    from alerts.config import settings
    monkeypatch.setattr(settings, "yahoo_enabled", True)
    calls = []
    def response(request):
        offset = int(request.url.params["start"])
        calls.append((request.url.params["scrIds"], offset))
        if request.url.params["scrIds"] == "equity":
            data = {"start": 0, "total": 19773, "records": [{"ticker": "AAPL"}]}
        else:
            data = {"start": offset, "total": 3, "records": [{"ticker": s, "companyName": s}
                for s in (["BTC-USD", "ETH-USD"] if offset == 0 else ["SOL-USD"])]}
        return httpx.Response(200, json={"finance": {"result": [data]}})
    client = httpx.Client
    monkeypatch.setattr(httpx, "Client", lambda **kw: client(transport=httpx.MockTransport(response)))
    result = catalog.refresh()
    assert len(result["partitions"]) == 2
    assert calls == [("ALL_CRYPTOCURRENCIES_US", 0), ("ALL_CRYPTOCURRENCIES_US", 2), ("equity", 0)]
    with database() as db:
        assert search(db, source="yahoo")["total"] == 3
        state = {row["partition"]: row for row in statuses(db, "yahoo")}
        assert state["crypto-usd"]["count"] == 3 and state["equity-us"]["status"] == "failed"
    # Duplicate/clamped pages cannot replace the previously successful snapshot.
    def repeated(request):
        return httpx.Response(200, json={"finance": {"result": [{"start": 0, "total": 3,
            "records": [{"ticker": "BAD-USD"}]}]}})
    monkeypatch.setattr(httpx, "Client", lambda **kw: client(transport=httpx.MockTransport(repeated)))
    catalog.refresh()
    with database() as db:
        assert search(db, source="yahoo", query="BAD")["total"] == 0
        assert search(db, source="yahoo")["total"] == 3


def test_legacy_eastmoney_rows_advertise_sina_daily_only_and_exclude_etfs(database, monkeypatch):
    import pytest
    from alerts.config import settings
    from alerts.history_catalog import catalog
    from alerts.history_mode_sources import dataset_identity
    from alerts.platform_catalog import catalog as platform
    monkeypatch.setattr(settings, "akshare_enabled", True)
    for symbol in ("SSE:600000", "SSE:510300"):
        publish("akshare", [{"id": symbol, "symbol": symbol, "label": symbol, "asset_type": "EQUITY",
            "metadata_json": {"source_family": "eastmoney-a"}}])
    with database() as db:
        rows = catalog(db, source="akshare")["items"]
        assert len(rows) == 1 and rows[0]["supported_frames"] == {"none": ["D1"]}
        rows = platform(db, source="akshare")["items"]
        assert all(row["capabilities"]["native_periods"] == ["D1"] for row in rows)
        tencent = next(row for row in rows if row["id"].startswith("TENCENT:"))
        describe(db, tencent["history_catalog_id"], "腾讯共用的中文名")
    for symbol in ("SSE:510300", "BSE:920001", "SHFE:RB2612"):
        with pytest.raises(ValueError):
            dataset_identity("akshare", symbol, "base_d1", "none")


def test_existing_adjusted_maintenance_matches_exact_identity(database, monkeypatch):
    from alerts.config import settings
    from alerts.history_mode_sources import dataset_identity
    from alerts.market_datasets import register_dataset
    from alerts.platform_catalog import catalog
    from alerts.storage import DatasetMaintenance, now_ms
    monkeypatch.setattr(settings, "akshare_enabled", True)
    symbol = "SSE:600000"
    publish("akshare", [{"id": symbol, "symbol": symbol, "label": "浦发银行", "asset_type": "EQUITY",
        "metadata_json": {"source_family": "sina-a"}}])
    ident = dataset_identity("akshare", symbol, "base_d1", "qfq")
    with database.begin() as db:
        register_dataset(db, ident, logical_symbol="SH600000", label="浦发银行", calendar="source_date",
            precision=4, volume_kind="quantity", volume_unit="shares", asset_class="equity",
            calendar_profile={"revision": ident.calendar_version, "trading_date": {"timezone": "Asia/Shanghai", "market": "SSE", "rule": ident.trading_date_rule, "close_minute": 910}})
        db.add(DatasetMaintenance(dataset_id=ident.key, target_start=0, timeframes=["D1"], next_at=now_ms()))
    with database() as db:
        rows = catalog(db, source="akshare")["items"]
        sina = next(row for row in rows if not row["id"].startswith("TENCENT:"))
        assert [r["id"] for r in sina["managed_datasets"]] == [ident.key]
        assert next(row for row in rows if row["id"].startswith("TENCENT:"))["managed_datasets"] == []


def test_binance_managed_adapter_retains_prices_and_retries_rate_limit(database):
    import httpx
    from alerts.aggregation_policy import history_dataset_identity
    from alerts.binance_history import BinanceHistory
    ident = history_dataset_identity(source="binance", provider_symbol="SUPERLONGASSETUSDT", asset_class="crypto")
    calls = []
    def response(request):
        calls.append(dict(request.url.params))
        return httpx.Response(200, json=[[60000, "1.123456789", "2", "1", "1.2", "12.3456789", 119999]])
    with httpx.Client(transport=httpx.MockTransport(response)) as client:
        page = BinanceHistory(client=client, clock=lambda: 300000).page(ident, 60000, 180000)
    assert calls[0]["symbol"] == "SUPERLONGASSETUSDT" and calls[0]["interval"] == "1m"
    assert page.rows[0].open == "1.123456789" and page.rows[0].volume == "12.3456789"
    assert page.checkpoint == 180000 and page.volume_kind == "base"
    with httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(429, headers={"Retry-After": "5"}))) as client:
        page = BinanceHistory(client=client, clock=lambda: 300000).page(ident, 60000, 180000)
    assert not page.result.successful and page.checkpoint == 60000 and not page.rows


def test_synced_yahoo_directory_loads_chart_metadata_without_waiting_for_directory_ttl(database, monkeypatch):
    from alerts import provider_yahoo, yahoo_catalog
    from alerts.config import settings
    from alerts.storage import now_ms
    monkeypatch.setattr(settings, "yahoo_enabled", True)
    symbol = "LOCAL-USD"
    publish("yahoo", [{"id": provider_yahoo.stable_id(symbol), "symbol": symbol, "label": "Directory label",
        "asset_type": "CRYPTOCURRENCY", "metadata_json": {"exchange": "CCC"}}], complete=True)
    calls = []
    def metadata(code, **kwargs):
        calls.append(code)
        return {"symbol": code, "english_name": "Local coin", "asset_type": "CRYPTOCURRENCY",
            "adjustment": "none", "timezone": "UTC", "session": "24x7", "updated_at": now_ms(),
            "volume_kind": "quantity"}
    monkeypatch.setattr(provider_yahoo, "metadata", metadata)
    assert yahoo_catalog.chart_metadata(provider_yahoo.stable_id(symbol))["timezone"] == "UTC"
    assert calls == [symbol]
    # Refreshing directory timestamps does not reset the independent metadata age.
    assert yahoo_catalog.chart_metadata(provider_yahoo.stable_id(symbol))["adjustment"] == "none"
    assert calls == [symbol]


def test_first_complete_partition_marks_missing_legacy_rows_without_touching_other_scopes(database):
    from alerts.history_catalog import account_scope
    with database.begin() as db:
        for ident, source, symbol, info in [
            ("old-a", "akshare", "SSE:600000", {"source_family": "sina-a"}),
            ("old-hk", "akshare", "HKEX:00700", {"source_family": "sina-hk"}),
            ("HC:old", "oanda", "EUR_USD", {"history_account_scope": account_scope()}),
            ("HC:other", "oanda", "GBP_USD", {"history_account_scope": "another-account"})]:
            db.add(MarketCatalog(id=ident, source=source, symbol=symbol, label=symbol,
                asset_type="EQUITY", precision=4, available=True, metadata_json=info))
    publish("akshare", [{"id": "new-a", "symbol": "SZSE:000001", "label": "平安银行"}],
        partition="a", complete=True, mark_missing=True)
    publish("oanda", [{"id": "HC:new", "symbol": "USD_JPY", "label": "USD JPY"}],
        scope=account_scope(), complete=True, mark_missing=True)
    with database() as db:
        assert not db.get(MarketCatalog, "old-a").available
        assert not db.get(MarketCatalog, "HC:old").available
        assert db.get(MarketCatalog, "old-hk").available and db.get(MarketCatalog, "HC:other").available


def test_exact_selected_identity_is_not_lost_behind_substring_pages(database, monkeypatch):
    from alerts.config import settings
    from alerts.history_catalog import validate_selection
    from alerts.instrument_directory import logical_symbol
    monkeypatch.setattr(settings, "yahoo_enabled", True)
    publish("yahoo", [{"id": "YAHOO:" + symbol, "symbol": symbol, "label": symbol, "asset_type": "EQUITY"}
        for symbol in ["F", *[f"AF{i:04d}" for i in range(120)]]])
    with database() as db:
        validate_selection(db, source="yahoo", provider_symbol="F", catalog_id="YAHOO:F",
            logical_symbol=logical_symbol("yahoo", "F"), asset_class="equity", precision=8)


def test_dukascopy_live_directory_keeps_instruments_without_group(database, monkeypatch):
    import httpx
    from alerts import catalog_sync
    from alerts.history_api import DatasetRequest
    payload = {"groups": [{"id": 3, "code": "FX", "parentId": None}], "instruments": [
        {"name": "EUR/USD", "code": "EUR-USD", "groupId": 3, "priceScale": 5},
        {"name": "DUK+/EUR", "code": "DUKplus-EUR", "groupId": None,
         "priceScale": 3, "platformGroupId": "CRYPTO_DC", "description": "Dukascoin vs Euro"},
        {"name": "SPY.US/USD", "code": "SPY.US-USD", "groupId": None, "priceScale": None}]}
    client = httpx.Client
    monkeypatch.setattr(httpx, "Client", lambda **kw: client(transport=httpx.MockTransport(
        lambda request: httpx.Response(200, json=payload))))
    assert catalog_sync.refresh_dukascopy()["count"] == 3
    with database() as db:
        item = search(db, source="dukascopy", query="DUK+")["items"][0]
        assert item["provider_symbol"] == "DUK+/EUR"
        assert item["metadata_json"]["provider_code"] == "DUKplus-EUR"
        assert search(db, source="dukascopy", query="SPY.US")["items"][0]["metadata_json"]["precision_status"] == "manual_required"
        DatasetRequest(source="dukascopy", logical_symbol=item["logical_symbol"],
            provider_symbol=item["symbol"], asset_class=item["asset_class"], precision=3)
