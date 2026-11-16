"""Product/source labels may change; saved prices and paged identities may not."""
import copy

import pytest
from alerts.market_presentation import present
from alerts.mobile_identity import mobile_identity


@pytest.mark.parametrize("kind,asset,exchange,extra,expected,product", [
    ("EQUITY","equity","SZSE",{},"深A",""),
    ("STOCK","equity","SSE",{},"沪A",""),
    ("EQUITY","equity","BSE",{},"北A",""),
    ("EQUITY","equity","NMS",{},"美股",""),
    ("EQUITY","equity","HKEX",{},"港股",""),
    ("EQUITY","equity","HK",{},"港股",""),
    ("EQUITY","equity","GB",{},"英股",""),
    ("EQUITY","equity","DE",{},"德股",""),
    ("EQUITY","equity","",{},"股票",""),
    ("ETF","etf","NMS",{},"ETF",""),
    ("FUND","etf","NMS",{},"基金",""),
    ("MUTUALFUND","etf","NMS",{},"基金",""),
    ("INDEX","index","",{},"指数",""),
    ("INDEX","index","",{"index_type":"stock"},"股指",""),
    ("INDEX","index","",{"index_type":"stock","product_type":"index_cfd"},"股指","CFD"),
    ("FUTURE","future","",{"contract_month":"2026-12"},"期货","2026-12"),
    ("CURRENCY","forex","",{},"外汇",""),
    ("METAL","metal","",{},"贵金属",""),
    ("CRYPTO","crypto","",{"contract_type":"PERPETUAL"},"加密","永续"),
    ("CRYPTO","crypto","",{"contract_type":"DELIVERY","delivery_date":"261225"},"加密","261225交割"),
    ("OPTION","other","",{"expiry":"261225","option_type":"call","strike":600},"期权","261225 call 600"),
    ("BOND","other","",{},"债券",""),
    ("COMMODITY","other","",{},"商品",""),
    ("CFD","other","",{},"待分类","CFD"),
    ("UNKNOWN","other","",{},"待分类",""),
])
def test_category_is_product_not_exchange_or_bucket(kind,asset,exchange,extra,expected,product):
    row={"source":"yahoo","symbol":"EXAMPLE","asset_type":kind,"asset_class":asset,"metadata_json":{"exchange":exchange,**extra}}
    before=copy.deepcopy(row)
    value=mobile_identity(row)
    assert value["category"]==expected
    assert value["product"]==product
    assert row==before


def test_saved_upstream_wins_and_web_display_stays_unchanged():
    identity={"source":"akshare","source_family":"tencent-a","provider_symbol":"SZSE:300750","adjustment":"qfq"}
    meta={"symbol":"300750","asset_class":"equity","metadata_json":{"source_family":"sina-a"}}
    original=copy.deepcopy((meta,identity))
    result=present(meta,identity=identity)
    assert result["source_display"]=="腾讯（AKShare）"
    assert result["mobile_identity"]==dict(category="深A",provider="腾讯财经",channel="AKShare",product="",environment="",provider_symbol="SZSE:300750")
    assert (meta,identity)==original
    assert mobile_identity(meta,{**identity,"source_family":"unknown"})["provider"]=="AKShare"


def test_spot_and_futures_are_not_interchangeable():
    assert mobile_identity({"source":"binance","asset_class":"crypto","symbol":"BTCUSDT"})["product"]=="现货"
    assert mobile_identity({"source":"akshare","source_family":"sina-futures","asset_class":"future","symbol":"SHFE:RB0"})["product"]=="主力连续"


def test_live_dukascopy_etf_group_keeps_known_product_form():
    row={"source":"dukascopy","symbol":"2822.HK/HKD","asset_type":"ETF","asset_class":"etf","metadata_json":{"group":"ETF_CFD","platform_group":"ETF"}}
    result=mobile_identity(row)
    assert (result["category"], result["product"]) == ("ETF", "CFD")
    # A stock directory group alone is not a reviewed contract/ownership fact.
    row.update(asset_type="EQUITY",asset_class="equity",metadata_json={"group":"STCK_CFD","platform_group":"STK_CASH"})
    assert mobile_identity(row)["product"] == ""


def test_upstream_aliases_qualify_native_variants_before_pagination(database,monkeypatch):
    from alerts.akshare_catalog import stable_id
    from alerts.config import settings
    from alerts.instrument_directory import search
    from alerts.market_data import _provider_series_page
    from alerts.storage import MarketCatalog
    monkeypatch.setattr(settings,"akshare_enabled",True)
    with database.begin() as db:
        for code in ("SZSE:300750","SSE:688256"):
            db.add(MarketCatalog(id=stable_id(code),source="akshare",symbol=code,label="宁德时代" if "300750" in code else "寒武纪",asset_type="EQUITY",precision=2,available=True,metadata_json={"source_family":"sina-a","exchange":code.split(":")[0]}))
    with database() as db:
        for term,prefixes in (("新浪财经",("SINA-NATIVE:","AKSHARE:")),("sina",("SINA-NATIVE:","AKSHARE:")),("腾讯财经",("TENCENT:","TENCENT-NATIVE:")),("tencent",("TENCENT:","TENCENT-NATIVE:"))):
            full=search(db,query="300750 "+term,mobile=True,source="akshare",limit=25)
            assert full["total"]==2
            assert all(r["id"].startswith(prefixes) for r in full["items"])
            pages=[search(db,query="300750 "+term,mobile=True,source="akshare",offset=i,limit=1)["items"][0]["id"] for i in range(2)]
            assert pages==[r["id"] for r in full["items"]]
        assert search(db,query="300750 AKShare",mobile=True,source="akshare")["total"]==4
        assert search(db,query="300750 腾讯财经",mobile=True,source="akshare",managed=True)["total"]==0
        assert search(db,query="300750 新浪财经",mobile=True,source="akshare",managed=True)["total"]==1
    rows=_provider_series_page("300750 腾讯财经",source="akshare",mobile=True)["items"]
    assert len(rows)==2 and all(r["mobile_identity"]["provider"]=="腾讯财经" for r in rows)


def test_price_aliases_filter_expanded_series_without_losing_page_members(database,monkeypatch):
    from alerts.akshare_catalog import stable_id
    from alerts.config import settings
    from alerts.instrument_directory import search
    from alerts.storage import MarketCatalog
    monkeypatch.setattr(settings,"akshare_enabled",True)
    with database.begin() as db:
        db.add(MarketCatalog(id=stable_id("SZSE:300750"),source="akshare",symbol="SZSE:300750",label="宁德时代",asset_type="EQUITY",precision=2,available=True,metadata_json={"source_family":"sina-a"}))
    with database() as db:
        none=search(db,query="宁德 新浪 不复权",source="akshare",mobile=True)["items"]
        assert len(none)==1 and none[0]["id"].startswith("SINA-NATIVE:")
        qfq=search(db,query="300750 腾讯 前复权",source="akshare",mobile=True)["items"]
        assert len(qfq)==1 and qfq[0]["id"].startswith("TENCENT:")
