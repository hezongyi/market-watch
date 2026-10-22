"""Read-only, scoped product rules for the two-step mapping editor.

Rules describe price products, never equivalence of broker trading contracts.
Unknown products stay blocked; supplied URLs or a checkbox cannot create a rule.
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, model_validator

from .config import settings
from .history_catalog import account_scope
from .market_contracts import DatasetIdentity
from .storage import Instrument, MarketCatalog, MarketDataset

PRODUCT_FIELDS = ("underlying", "quote_currency", "historical_product", "live_product", "relationship")
DK_FX = "https://www.dukascopy.com/swiss/english/forex/forex-trading-accounts/link/"
DK_HISTORY = "https://www.dukascopy.com/swiss/english/marketwatch/historical/"
DK_GOLD = "https://www.dukascopy.com/swiss/english/cfd/range-of-markets/gold/"
OA_TYPES = "https://developer.oanda.com/rest-live-v20/primitives-df/#InstrumentType"
OA_ACCOUNT = "https://developer.oanda.com/rest-live-v20/account-ep/#collapse_1"


class MappingDraft(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    schema_version: Literal[2] = 2
    underlying: str = Field(default="", max_length=30)
    quote_currency: str = Field(default="", max_length=8)
    historical_product: str = Field(default="", max_length=30)
    live_product: str = Field(default="", max_length=30)
    relationship: str = Field(default="", max_length=50)
    historical_evidence: HttpUrl | None = None
    live_evidence: HttpUrl | None = None
    rationale: str = Field(default="", max_length=1000)  # optional independent note
    reviewed: bool = False  # only acknowledges the rule's specific difference

    @model_validator(mode="after")
    def safe_evidence(self):
        for url in (self.historical_evidence, self.live_evidence):
            if url and (url.username or url.password):
                raise ValueError("匹配依据URL不能包含凭据")
        return self


class CatalogSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    account_scope: str
    provider_symbol: str
    asset_type: str
    precision: int


def selection(db, dataset_id, catalog_id):
    dataset = db.get(MarketDataset, dataset_id)
    if not dataset:
        raise ValueError("自建数据集不存在")
    historical = DatasetIdentity.model_validate(dataset.identity)
    if historical.basis != "bid":
        raise ValueError("首版组合只接续一致的Bid价格口径")
    entry = db.get(MarketCatalog, catalog_id)
    if (not entry or entry.source != "oanda" or not entry.available or
            entry.metadata_json.get("history_account_scope") != account_scope()):
        raise ValueError("请选择当前OANDA Practice账户目录中的准确品种")
    if not settings.oanda_account_id or not settings.oanda_token:
        raise ValueError("OANDA Practice连接尚未配置")
    snapshot = CatalogSnapshot(account_scope=account_scope(), provider_symbol=entry.symbol,
        asset_type=entry.asset_type, precision=entry.precision)
    return dataset, historical, entry, snapshot


def product_rule(historical, entry):
    """Explicit source + exact-symbol + provider-type allowlist, not fuzzy matching.

    2026-10-22 source review: OANDA CURRENCY/METAL are API price categories.
    METAL does not establish the account's legal CFD/spot contract. Gold is
    therefore labelled metal_quote, never silently labelled spot_metal.
    """
    sources = [{"url": OA_TYPES, "scope": "v20 InstrumentType: CURRENCY / METAL / CFD"},
        {"url": OA_ACCOUNT, "scope": "当前 Practice 账户可交易目录、准确代码及精度"}]
    defaults, difference = {}, None
    if (historical.source == "dukascopy" and historical.channel == "python" and
            historical.environment == "historical" and historical.account_scope == "public"):
        sources += [{"url": DK_HISTORY, "scope": "Dukascopy 历史报价来源"}]
        fx = {"EUR/USD": ("EUR_USD", "EUR", "USD"), "USD/CAD": ("USD_CAD", "USD", "CAD")}
        if historical.provider_symbol in fx and entry.asset_type == "CURRENCY":
            code, base, quote = fx[historical.provider_symbol]
            if code == entry.symbol:
                sources += [{"url": DK_FX, "scope": "JForex 外汇报价；仅 EUR/USD、USD/CAD"}]
                defaults = dict(underlying=base, quote_currency=quote, historical_product="spot_fx",
                    live_product="spot_fx", relationship="same_product")
        elif historical.provider_symbol == "XAU/USD" and entry.symbol == "XAU_USD" and entry.asset_type == "METAL":
            sources += [{"url": DK_GOLD, "scope": "XAU/USD Rolling Spot Metals 属于 Gold CFD；基于伦敦现货报价"}]
            defaults = dict(underlying="XAU", quote_currency="USD", historical_product="cfd",
                live_product="metal_quote", relationship="same_underlying_different_product")
            difference = "历史为 Dukascopy 滚动黄金 CFD 报价；实时为 OANDA METAL 报价。二者同为 XAU/USD，但不是同一产品或经纪商合约，保留原价差异。"
    elif (historical.source == "oanda" and historical.environment == "practice" and
            historical.account_scope == account_scope() and historical.provider_symbol == entry.symbol):
        known = {"EUR_USD": ("EUR", "USD", "CURRENCY", "spot_fx"),
            "USD_CAD": ("USD", "CAD", "CURRENCY", "spot_fx"),
            "XAU_USD": ("XAU", "USD", "METAL", "metal_quote")}
        if entry.symbol in known:
            base, quote, kind, product = known[entry.symbol]
            if kind == entry.asset_type:
                defaults = dict(underlying=base, quote_currency=quote, historical_product=product,
                    live_product=product, relationship="same_product")
    return defaults, sources, difference


def check_match(db, dataset_id, catalog_id, draft=None):
    dataset, historical, entry, snapshot = selection(db, dataset_id, catalog_id)
    defaults, sources, difference = product_rule(historical, entry)
    supplied = MappingDraft.model_validate(draft) if draft is not None else None
    errors = {}
    if not defaults:
        errors["relationship"] = "尚无适用于这两个准确来源品种及账户目录类型的产品规则，请补充适用的来源资料供核实。修改分类、网址或勾选不能代替核实。"
    elif supplied:
        for field in PRODUCT_FIELDS:
            if getattr(supplied, field) != defaults[field]:
                errors[field] = "与服务端核实的准确来源身份/产品规则不一致，请更正或更换品种。"
        if difference and not supplied.reviewed:
            errors["reviewed"] = "请确认所示黄金报价产品差异与 Bid 原价接续。"
    target_identity = DatasetIdentity(source="oanda", channel="v20", environment="practice",
        account_scope=account_scope(), provider_symbol=entry.symbol, basis="bid",
        calendar_version=settings.oanda_calendar_version)
    target = db.get(MarketDataset, target_identity.key)
    if target and db.get(Instrument, target.instrument_id).precision != entry.precision:
        errors["relationship"] = "当前目录精度与已登记实时数据集冲突，请先维护来源数据集；不能自动改写既有数据或组合。"
    result = {"status": "needs_information" if errors else "ready", "errors": errors,
        "suggestion": {**MappingDraft().model_dump(mode="json"), **defaults},
        "snapshot": snapshot.model_dump(), "sources": sources, "difference": difference,
        "rule": "source-price-products-20261022-v1" if defaults else None,
        "conclusion": ("同标的同币种，已知报价产品差异" if difference else
            "同标的同币种、同类外汇/金属报价；不代表相同经纪商合约") if defaults else "产品关系待核实"}
    return result
